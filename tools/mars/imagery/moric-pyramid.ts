import { availableParallelism } from "node:os";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { hashFile, storagePath, writeJson } from "../../lunar/storage";
import { levelSize, type IRgbLevel } from "./area-pyramid";
import { MORIC, type IMoricSourceManifest, type IPlateCarree } from "./moric";
import type { IPyramidBand, IPyramidWorkerData } from "./moric-pyramid-worker";

/** Coarsest level of the pyramid: one pixel of level 8 averages 256 by 256 source pixels. */
export const PYRAMID_MAX_K = 8;
/** Finest level kept on disk; finer levels are reduced from source windows when a tile needs them. */
export const PYRAMID_MIN_K = 3;

/** Receipt of a pyramid on disk, bound to the SHA-256 of its source. */
export interface IPyramidManifest {
    schema: "mars-area-pyramid/1";
    source: string;
    sourceSha256: string;
    geometry: IPlateCarree;
    levels: Array<{ k: number; width: number; height: number; path: string; sha256: string }>;
    /** Source pixels black in all three bands. */
    blackPixels: number;
}

function pyramidDirectory(source: IMoricSourceManifest): string {
    return `derived/${MORIC.id}/pyramid-${source.sha256.slice(0, 16)}`;
}

/**
 * Builds the area pyramid of MoRIC, levels {@link PYRAMID_MIN_K} to {@link PYRAMID_MAX_K}, in one parallel read of the
 * source by bands of 256 rows, and writes each level as raw RGB beside a manifest. An existing pyramid of the same
 * source is reused.
 */
export async function moricPyramid(root: string, source: IMoricSourceManifest): Promise<IPyramidManifest> {
    const directory = pyramidDirectory(source);
    const manifestPath = storagePath(root, `${directory}/pyramid.json`);
    try {
        const previous = JSON.parse(await readFile(manifestPath, "utf8")) as IPyramidManifest;
        if (previous.schema === "mars-area-pyramid/1" && previous.sourceSha256 === source.sha256) return previous;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const geometry = source.geometry;
    const work = storagePath(root, `${directory}.work`);
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const ks = Array.from({ length: PYRAMID_MAX_K - PYRAMID_MIN_K + 1 }, (_, i) => PYRAMID_MIN_K + i);
    const handles = new Map(await Promise.all(ks.map(async (k) => [k, await open(`${work}/k${k}.rgb`, "w")] as const)));
    const bandRows = 2 ** PYRAMID_MAX_K;
    const bands = Array.from({ length: Math.ceil(geometry.height / bandRows) }, (_, i) => i * bandRows);
    const workerData: IPyramidWorkerData = {
        file: storagePath(root, MORIC.file),
        geometry,
        bandRows,
        minK: PYRAMID_MIN_K,
        maxK: PYRAMID_MAX_K,
    };
    const workers: Worker[] = [];
    let blackPixels = 0,
        completed = 0,
        next = 0;
    const started = Date.now();
    try {
        await new Promise<void>((accept, reject) => {
            const count = Math.min(bands.length, Math.max(1, availableParallelism() - 2));
            for (let i = 0; i < count; i++) {
                const worker = new Worker(new URL("./moric-pyramid-worker.mjs", import.meta.url), {
                    workerData,
                    execArgv: [],
                });
                workers.push(worker);
                worker.on("error", reject);
                worker.on("exit", (code) => {
                    if (code && completed < bands.length) reject(new Error(`Pyramid worker exited with ${code}`));
                });
                worker.on("message", async (message: { type: string; band?: IPyramidBand; message?: string }) => {
                    if (message.type === "failure") return reject(new Error(message.message));
                    if (message.type === "band") {
                        const band = message.band!;
                        try {
                            for (const level of band.levels) {
                                const { width } = levelSize(geometry, level.k);
                                await handles
                                    .get(level.k)!
                                    .write(level.data, 0, level.data.length, level.row0 * width * 3);
                            }
                        } catch (error) {
                            return reject(error);
                        }
                        blackPixels += band.black;
                        completed++;
                        if (completed % 25 === 0 || completed === bands.length) {
                            const seconds = (Date.now() - started) / 1000;
                            console.log(
                                `MoRIC pyramid: ${completed}/${bands.length} bands, ${seconds.toFixed(0)} s, ` +
                                    `about ${((seconds / completed) * (bands.length - completed)).toFixed(0)} s left.`,
                            );
                        }
                        if (completed === bands.length) return accept();
                    }
                    if (next < bands.length) worker.postMessage(bands[next++]);
                });
            }
        });
    } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
        await Promise.all([...handles.values()].map((handle) => handle.close()));
    }

    const levels: IPyramidManifest["levels"] = [];
    for (const k of ks)
        levels.push({ k, ...levelSize(geometry, k), path: `k${k}.rgb`, sha256: await hashFile(`${work}/k${k}.rgb`) });
    const manifest: IPyramidManifest = {
        schema: "mars-area-pyramid/1",
        source: MORIC.id,
        sourceSha256: source.sha256,
        geometry,
        levels,
        blackPixels,
    };
    await writeJson(`${work}/pyramid.json`, manifest);
    await rm(storagePath(root, directory), { recursive: true, force: true });
    await rename(work, storagePath(root, directory));
    console.log(`MoRIC pyramid written: ${blackPixels} source pixels are black in all bands.`);
    return manifest;
}

/** Loads one whole level of a pyramid into memory. */
export async function loadPyramidLevel(root: string, source: IMoricSourceManifest, k: number): Promise<IRgbLevel> {
    const manifest = await moricPyramid(root, source);
    const level = manifest.levels.find((candidate) => candidate.k === k);
    if (!level) throw new Error(`The MoRIC pyramid has no level ${k}.`);
    const data = await readFile(storagePath(root, `${pyramidDirectory(source)}/${level.path}`));
    if (data.length !== level.width * level.height * 3)
        throw new Error(`Level ${k} of the MoRIC pyramid is truncated.`);
    return {
        k,
        row0: 0,
        col0: 0,
        rows: level.height,
        cols: level.width,
        data: new Uint8Array(data.buffer, data.byteOffset, data.length),
    };
}

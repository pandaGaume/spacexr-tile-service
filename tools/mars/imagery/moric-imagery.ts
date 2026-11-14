import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { ITileAddress } from "@spacexr/tiles/addressing";
import { cubeTileOfDirection } from "@spacexr/tiles/cube";
import { planetocentricDirection } from "@spacexr/tiles/surface";
import { verifyGlobalBorders } from "../../lunar/global-kernel";
import { sha256, storagePath, renameDirectory, writeJson } from "../../lunar/storage";
import { FRAME, MARS_2000, marsSubtrees } from "../global-cube";
import type { IRgbLevel } from "./area-pyramid";
import { forEachVertex, levelsLookup, pixelBox, sampleTile, TILE_SIZE } from "./cube-area-sampler";
import {
    histogramSummary,
    imageryTileKey,
    parentHistogram,
    writeImageryTile,
    type IMarsImageryFile,
    type IUnitResult,
    type IUnitWorkerData,
} from "./imagery-units";
import { MORIC, moricSourceManifest, type IPlateCarree } from "./moric";
import { loadPyramidLevel, moricPyramid, PYRAMID_MAX_K, PYRAMID_MIN_K } from "./moric-pyramid";

/** A region of the imagery below the global levels, as a longitude and latitude box in degrees. */
export interface IImageryWindow {
    id: string;
    west: number;
    east: number;
    south: number;
    north: number;
}

/** Windows of MoRIC below its global levels: Jezero, the extent of its CTX orthomosaic. */
export const MORIC_WINDOWS: readonly IImageryWindow[] = [
    { id: "jezero", west: 77.0, east: 78.6, south: 17.6, north: 19.3 },
];

/** Manifest of a Mars imagery revision. */
export interface IMarsImageryManifest {
    schema: "mars-imagery/1";
    revision: string;
    status: "verified";
    /** Levels available everywhere. */
    maxLOD: number;
    tileSize: number;
    frame: string;
    referenceRadii: readonly [number, number, number];
    createdAt: string;
    sources: Array<{
        id: string;
        url: string;
        credit: string;
        rights: string;
        sha256: string;
        resolutionMetres: number;
        minLOD: number;
        maxLOD: number;
        /** `global`, or the windows below the global levels. */
        coverage: "global" | IImageryWindow[];
        tiles: number;
    }>;
    /**
     * Each tile against its parent at the samples they share, by level: the median and 95th percentile of the largest
     * absolute difference of the three channels. A parent averages four times the area of its child, so the difference
     * measures the detail a level adds; a misplaced or shifted tile shows as an outlier.
     */
    parentDifference: Array<{ lod: number; median: number; p95: number; max: number }>;
    /** Tiles, without their border hashes. */
    files: IMarsImageryFile[];
    sharedBordersVerified: number;
    bytes: number;
}

/** Smallest pyramid level a vertex of `lod` reads, over every vertex of a face. */
function minimumLevel(geometry: IPlateCarree, lod: number): number {
    let minimum = Infinity;
    // The footprint shrinks from the centre of a face to its corners, alike at the four of them: the tile holding one
    // corner holds the smallest.
    forEachVertex({ face: 0, lod, x: 0, y: 0 }, geometry.sphereRadius, (_, footprint) => {
        minimum = Math.min(minimum, pixelBox(geometry, footprint, PYRAMID_MAX_K).k);
    });
    return minimum;
}

/** Deepest level whose nominal pixel, at the centre of a face, is not finer than the source pixel. */
export function deepestLevel(geometry: IPlateCarree): number {
    const nominal = (geometry.sphereRadius * Math.PI) / (2 * TILE_SIZE);
    return Math.floor(Math.log2(nominal / geometry.pixelMetres));
}

/** Tiles of `lod` that contain a point of a window, on a grid finer than a tile of that level. */
function windowTiles(window: IImageryWindow, lod: number): ITileAddress[] {
    const tiles = new Map<string, ITileAddress>();
    const step = 90 / 2 ** lod / 16;
    for (let latitude = window.south; latitude <= window.north + step / 2; latitude += step)
        for (let longitude = window.west; longitude <= window.east + step / 2; longitude += step) {
            const address = cubeTileOfDirection(
                planetocentricDirection(Math.min(latitude, window.north), Math.min(longitude, window.east)),
                lod,
            );
            tiles.set(imageryTileKey(address), address);
        }
    return [...tiles.values()];
}

/** Every tile of a level, on the six faces. */
function levelTiles(lod: number): ITileAddress[] {
    const tiles: ITileAddress[] = [];
    for (let face = 0; face < 6; face++)
        for (let y = 0; y < 2 ** lod; y++) for (let x = 0; x < 2 ** lod; x++) tiles.push({ face, lod, x, y });
    return tiles;
}

/** Builds the units in parallel workers; each returns its tiles and the histograms of their parent differences. */
async function buildUnits(
    units: readonly ITileAddress[],
    workerData: IUnitWorkerData,
    onUnit: (result: IUnitResult) => void,
): Promise<void> {
    const workers: Worker[] = [];
    let next = 0,
        completed = 0;
    const started = Date.now();
    try {
        await new Promise<void>((accept, reject) => {
            if (units.length === 0) return accept();
            const count = Math.min(units.length, Math.max(1, availableParallelism() - 2));
            for (let i = 0; i < count; i++) {
                const worker = new Worker(new URL("./moric-unit-worker.mjs", import.meta.url), {
                    workerData,
                    execArgv: [],
                });
                workers.push(worker);
                worker.on("error", reject);
                worker.on("exit", (code) => {
                    if (code && completed < units.length) reject(new Error(`Imagery worker exited with ${code}`));
                });
                worker.on("message", (message: { type: string; result?: IUnitResult; message?: string }) => {
                    if (message.type === "failure") return reject(new Error(message.message));
                    if (message.type === "unit") {
                        onUnit(message.result!);
                        completed++;
                        if (completed % 64 === 0 || completed === units.length) {
                            const seconds = (Date.now() - started) / 1000;
                            console.log(
                                `Units: ${completed}/${units.length}, ${seconds.toFixed(0)} s, about ` +
                                    `${((seconds / completed) * (units.length - completed)).toFixed(0)} s left.`,
                            );
                        }
                        if (completed === units.length) return accept();
                    }
                    if (next < units.length) worker.postMessage(units[next++]);
                });
            }
        });
    } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
    }
}

/**
 * Builds a Mars imagery revision from Tianwen-1 MoRIC: every tile of the levels whose footprints the stored pyramid
 * holds, then, below them, every tile down to the deepest level of the source, over the whole planet or inside windows.
 * Each sample is the area mean of the source over its cell. Writes `datasets/mars/imagery-<revision>/` with
 * `imagery.json` and its manifest, then `catalog/latest-imagery.json`.
 *
 * @param coverage - `global`, or the windows to build below the global levels.
 */
export async function buildMoricImagery(
    root: string,
    coverage: "global" | readonly IImageryWindow[] = MORIC_WINDOWS,
): Promise<string> {
    const source = await moricSourceManifest(root);
    const geometry = source.geometry;
    await moricPyramid(root, source);
    const deepest = deepestLevel(geometry);
    let globalMaxLOD = 0;
    while (globalMaxLOD < deepest && minimumLevel(geometry, globalMaxLOD + 1) >= PYRAMID_MIN_K) globalMaxLOD++;
    const units =
        coverage === "global"
            ? levelTiles(globalMaxLOD + 1)
            : [
                  ...new Map(
                      coverage
                          .flatMap((window) => windowTiles(window, globalMaxLOD + 1))
                          .map((address) => [imageryTileKey(address), address]),
                  ).values(),
              ];
    console.log(
        `MoRIC: levels 0-${globalMaxLOD} everywhere, ${globalMaxLOD + 1}-${deepest} ` +
            `${coverage === "global" ? "everywhere" : `in ${coverage.map((w) => w.id).join(", ")}`}, ${units.length} units.`,
    );

    const work = storagePath(root, `work/mars-imagery-${randomUUID()}`);
    const files: IMarsImageryFile[] = [];
    const histograms = new Map<number, number[]>();
    const addHistograms = (byLevel: Record<number, number[]>): void => {
        for (const [lod, counts] of Object.entries(byLevel)) {
            const total = histograms.get(Number(lod)) ?? new Array<number>(256).fill(0);
            counts.forEach((count, value) => (total[value]! += count));
            histograms.set(Number(lod), total);
        }
    };
    let built = false;
    try {
        const pyramid = new Map<number, IRgbLevel>();
        for (let k = PYRAMID_MIN_K; k <= PYRAMID_MAX_K; k++) pyramid.set(k, await loadPyramidLevel(root, source, k));
        const levelAt = levelsLookup(pyramid);
        const rgbs = new Map<string, Uint8Array>();
        for (let lod = 0; lod <= globalMaxLOD; lod++) {
            const tiles = levelTiles(lod);
            const histogram = new Array<number>(256).fill(0);
            await Promise.all(
                tiles.map(async (address) => {
                    const rgb = sampleTile(address, geometry, levelAt, PYRAMID_MAX_K);
                    rgbs.set(imageryTileKey(address), rgb);
                    files.push(await writeImageryTile(work, address, rgb, MORIC.id));
                }),
            );
            if (lod > 0) {
                for (const address of tiles)
                    parentHistogram(
                        address,
                        rgbs.get(imageryTileKey(address))!,
                        rgbs.get(imageryTileKey({ ...address, lod: lod - 1, x: address.x >> 1, y: address.y >> 1 }))!,
                        histogram,
                    );
                addHistograms({ [lod]: histogram });
            }
            console.log(`Level ${lod}: ${tiles.length} tiles.`);
        }
        rgbs.clear();
        pyramid.clear();

        await buildUnits(
            units,
            {
                file: storagePath(root, MORIC.file),
                geometry,
                work,
                source: MORIC.id,
                maxLOD: deepest,
                alignK: PYRAMID_MIN_K,
            },
            (result) => {
                files.push(...result.files);
                addHistograms(result.histograms);
            },
        );

        const sharedBordersVerified = verifyGlobalBorders(
            files as Array<IMarsImageryFile & { borders: string[] }>,
            coverage === "global",
        );
        for (const file of files) delete file.borders;
        const parentDifference = [...histograms.entries()]
            .sort(([a], [b]) => a - b)
            .map(([lod, histogram]) => ({ lod, ...histogramSummary(histogram) }));

        files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const revision = sha256(Buffer.from(files.map((file) => `${file.path} ${file.sha256}`).join("\n"))).slice(
            0,
            20,
        );
        const maxLOD = coverage === "global" ? deepest : globalMaxLOD;
        const subtrees = coverage === "global" ? [] : marsSubtrees(files, globalMaxLOD);
        await writeJson(resolve(work, "imagery.json"), {
            scheme: "spacexr-cube-equiangular/1",
            body: "Mars",
            frame: FRAME,
            referenceRadii: MARS_2000,
            content: "imagery",
            encoding: "webp",
            tileSize: TILE_SIZE,
            minLOD: 0,
            maxLOD,
            subtrees,
            tiles: "./imagery/{face}/{z}/{x}/{y}.webp",
        });
        const manifest: IMarsImageryManifest = {
            schema: "mars-imagery/1",
            revision,
            status: "verified",
            maxLOD,
            tileSize: TILE_SIZE,
            frame: FRAME,
            referenceRadii: MARS_2000,
            createdAt: new Date().toISOString(),
            sources: [
                {
                    id: MORIC.id,
                    url: source.url,
                    credit: source.credit,
                    rights: MORIC.rights,
                    sha256: source.sha256,
                    resolutionMetres: geometry.pixelMetres,
                    minLOD: 0,
                    maxLOD: deepest,
                    coverage: coverage === "global" ? "global" : [...coverage],
                    tiles: files.length,
                },
            ],
            parentDifference,
            files,
            sharedBordersVerified,
            bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        };
        await writeJson(resolve(work, "manifest.json"), manifest);
        built = true;

        const directory = `datasets/mars/imagery-${revision}`;
        const target = storagePath(root, directory);
        if (
            await stat(target).then(
                () => true,
                () => false,
            )
        ) {
            console.log(`Revision ${revision} already exists; nothing written.`);
            await rm(work, { recursive: true, force: true });
        } else {
            await mkdir(dirname(target), { recursive: true });
            await renameDirectory(work, target);
        }
        await writeJson(storagePath(root, "catalog/latest-imagery.json"), { directory, revision });
        console.log(
            `Mars imagery ${revision}: ${files.length} tiles, ${subtrees.length} subtrees, ` +
                `${sharedBordersVerified} shared borders verified, ${(manifest.bytes / 1e9).toFixed(2)} GB.`,
        );
        for (const { lod, median, p95, max } of parentDifference)
            console.log(`  level ${lod} against its parent: median ${median}, p95 ${p95}, max ${max}`);
        return revision;
    } catch (error) {
        // Tiles already built are kept: a failed rename leaves them to be moved by hand.
        if (built) console.error(`The finished revision stays in ${work}.`);
        else await rm(work, { recursive: true, force: true });
        throw error;
    }
}

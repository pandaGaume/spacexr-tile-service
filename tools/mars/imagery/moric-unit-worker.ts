import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { fromFile } from "geotiff";
import sharp from "sharp";
import type { ITileAddress } from "@spacexr/tiles/addressing";
import { reduceWindow, type IRgbLevel } from "./area-pyramid";
import { blocksLookup, sampleTile, SOURCE_BLOCK, sourceBlocks } from "./cube-area-sampler";
import {
    descendants,
    imageryTileKey,
    parentHistogram,
    writeImageryTile,
    type IMarsImageryFile,
    type IUnitResult,
    type IUnitWorkerData,
} from "./imagery-units";

const input = workerData as IUnitWorkerData;
const image = await (await fromFile(input.file)).getImage(0);
sharp.concurrency(1);

async function buildUnit(unit: ITileAddress): Promise<IUnitResult> {
    const tiles = descendants(unit, input.maxLOD);
    const blocks = new Map<number, Map<number, IRgbLevel>>();
    for (const window of sourceBlocks(tiles, input.geometry, input.alignK, input.alignK)) {
        const data = (await image.readRasters({
            window: [window.col0, window.row0, window.col0 + window.cols, window.row0 + window.rows],
            interleave: true,
        })) as unknown as Uint8Array;
        const base: IRgbLevel = { k: 0, ...window, data };
        const block = window.col0 / SOURCE_BLOCK;
        for (const level of [base, ...reduceWindow(input.geometry, base, input.alignK)]) {
            if (!blocks.has(level.k)) blocks.set(level.k, new Map());
            blocks.get(level.k)!.set(block, level);
        }
    }
    const levelAt = blocksLookup(blocks);
    const rgbs = new Map<string, Uint8Array>();
    const files: IMarsImageryFile[] = [];
    for (const address of tiles) {
        const rgb = sampleTile(address, input.geometry, levelAt, input.alignK);
        rgbs.set(imageryTileKey(address), rgb);
        files.push(await writeImageryTile(input.work, address, rgb, input.source));
    }
    const parentAddress = { face: unit.face, lod: unit.lod - 1, x: unit.x >> 1, y: unit.y >> 1 };
    // Read into memory: libvips would keep the file open in its cache, shared by every thread of the process.
    const parentBytes = await readFile(resolve(input.work, `imagery/${imageryTileKey(parentAddress)}.webp`));
    const { data: parent } = await sharp(parentBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    rgbs.set(imageryTileKey(parentAddress), new Uint8Array(parent.buffer, parent.byteOffset, parent.length));
    const histograms: IUnitResult["histograms"] = {};
    for (const address of tiles) {
        const parentRgb = rgbs.get(
            imageryTileKey({ face: address.face, lod: address.lod - 1, x: address.x >> 1, y: address.y >> 1 }),
        )!;
        const histogram = (histograms[address.lod] ??= new Array<number>(256).fill(0));
        parentHistogram(address, rgbs.get(imageryTileKey(address))!, parentRgb, histogram);
    }
    return { files, histograms };
}

parentPort!.on("message", async (unit: ITileAddress) => {
    try {
        parentPort!.postMessage({ type: "unit", result: await buildUnit(unit) });
    } catch (error) {
        parentPort!.postMessage({ type: "failure", message: error instanceof Error ? error.stack : String(error) });
    }
});
parentPort!.postMessage({ type: "ready" });

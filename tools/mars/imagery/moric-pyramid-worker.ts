import { parentPort, workerData } from "node:worker_threads";
import { fromFile } from "geotiff";
import { reduceWindow } from "./area-pyramid";
import type { IPlateCarree } from "./moric";

/** Input of a pyramid worker. */
export interface IPyramidWorkerData {
    file: string;
    geometry: IPlateCarree;
    /** Source rows per band: `2^maxK`, so a band holds whole blocks of every level. */
    bandRows: number;
    minK: number;
    maxK: number;
}

/** Result of one band: the rows of levels `minK` to `maxK` it holds, and its source pixels black in all bands. */
export interface IPyramidBand {
    row0: number;
    levels: Array<{ k: number; row0: number; rows: number; data: Uint8Array }>;
    black: number;
}

const input = workerData as IPyramidWorkerData;
const image = await (await fromFile(input.file)).getImage(0);

parentPort!.on("message", async (row0: number) => {
    try {
        const rows = Math.min(input.bandRows, input.geometry.height - row0);
        const data = (await image.readRasters({
            window: [0, row0, input.geometry.width, row0 + rows],
            interleave: true,
        })) as unknown as Uint8Array;
        let black = 0;
        for (let i = 0; i < data.length; i += 3) if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) black++;
        const levels = reduceWindow(
            input.geometry,
            { k: 0, row0, col0: 0, rows, cols: input.geometry.width, data },
            input.maxK,
        )
            .filter((level) => level.k >= input.minK)
            .map((level) => ({ k: level.k, row0: level.row0, rows: level.rows, data: level.data }));
        const band: IPyramidBand = { row0, levels, black };
        parentPort!.postMessage(
            { type: "band", band },
            levels.map((level) => level.data.buffer as ArrayBuffer),
        );
    } catch (error) {
        parentPort!.postMessage({ type: "failure", message: error instanceof Error ? error.stack : String(error) });
    }
});
parentPort!.postMessage({ type: "ready" });

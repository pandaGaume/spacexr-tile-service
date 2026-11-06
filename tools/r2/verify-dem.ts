import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { terrariumHeight } from "@spacexr/dem";
import type { IPublicationReceipt } from "./common";

/** Verify the real generated PNGs against Float32 heights, then check every shared edge. */
async function main(): Promise<void> {
    const path = process.argv[2] ?? ".local/r2-nasa-moon/latest.json";
    const receipt = JSON.parse(await readFile(path, "utf8")) as IPublicationReceipt;
    const grids = new Map<string, Float32Array>();
    let largestError = 0,
        samples = 0;
    for (const object of receipt.objects) {
        const match = /\/dem-f32\/(\d+)\/(\d+)\/(\d+)\.f32$/.exec(object.key);
        if (!match) continue;
        const [, z, x, y] = match;
        const bytes = await readFile(object.file);
        if (bytes.length !== 257 * 257 * 4) throw new Error("Invalid Float32 byte length");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const grid = Float32Array.from({ length: 257 * 257 }, (_, index) => view.getFloat32(index * 4, true));
        grids.set(`${z}/${x}/${y}`, grid);
        const pngKey = object.key.replace("/dem-f32/", "/dem/").replace(/\.f32$/, ".png");
        const png = receipt.objects.find((candidate) => candidate.key === pngKey);
        if (!png) throw new Error(`Missing matching Terrarium grid: ${pngKey}`);
        const image = await sharp(await readFile(png.file))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        if (image.info.width !== 257 || image.info.height !== 257 || image.info.channels !== 4)
            throw new Error("Invalid Terrarium dimensions");
        for (let index = 0; index < grid.length; index++) {
            const offset = index * 4;
            if (!Number.isFinite(grid[index]) || image.data[offset + 3] !== 255) throw new Error("Unexpected NoData");
            const decoded = terrariumHeight(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
            const error = Math.abs(decoded - grid[index]);
            if (error > 1 / 512) throw new Error(`Terrarium exceeds half-step error at ${object.key}:${index}`);
            largestError = Math.max(largestError, error);
            samples++;
        }
    }
    if (!grids.size) throw new Error("No DEM grids in receipt");
    for (const [address, grid] of grids) {
        const [z, x, y] = address.split("/").map(Number);
        const east = grids.get(`${z}/${(x + 1) % (2 * 2 ** z)}/${y}`);
        const south = grids.get(`${z}/${x}/${y + 1}`);
        for (let index = 0; index <= 256; index++) {
            if (east && grid[index * 257 + 256] !== east[index * 257])
                throw new Error(`East seam mismatch: ${address}`);
            if (south && grid[256 * 257 + index] !== south[index]) throw new Error(`South seam mismatch: ${address}`);
        }
    }
    console.log(
        JSON.stringify(
            { grids: grids.size, samples, largestTerrariumErrorMetres: largestError, sharedBorders: "identical" },
            null,
            2,
        ),
    );
}
await main();

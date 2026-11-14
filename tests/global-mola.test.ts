import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { GlobalMola } from "../tools/mars/global-mola";

describe("global MOLA terrain", () => {
    it("publishes six complete roots and rejects invalid tile addresses", async () => {
        const global = new GlobalMola("missing-mars-fixture");
        expect(await global.available()).toBe(false);
        const source = global.source();
        expect(source.tiles).toHaveLength(2046);
        expect(source.tiles.filter((t) => t.lod === 0).map((t) => t.face)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(global.address("/global-mola-16ppd-v1/0/4/16/0.png")).toBeUndefined();
        expect(global.address("/global-mola-16ppd-v1/6/0/0/0.png")).toBeUndefined();
        expect(global.address("/global-mola-16ppd-v1/0/5/0/0.png")).toBeUndefined();
    });
    it("reprojects negative radial heights and preserves shared edges, including the longitude wrap and poles", async () => {
        const root = await mkdtemp(join(tmpdir(), "mars-mola-test-"));
        try {
            const directory = resolve(root, "sources/mola/meg016");
            await mkdir(directory, { recursive: true });
            const data = Buffer.alloc(5760 * 2880 * 2);
            for (let y = 0; y < 2880; y++)
                for (let x = 0; x < 5760; x++)
                    data.writeInt16BE(Math.round(-1000 + 100 * Math.cos((x / 5760) * 2 * Math.PI)), (y * 5760 + x) * 2);
            await writeFile(resolve(directory, "megr90n000eb.img"), data);
            const global = new GlobalMola(root);
            expect(await global.available()).toBe(true);
            const decode = async (face: number, lod: number, x: number, y: number) => {
                const { data } = await sharp(await global.tile({ face, lod, x, y }))
                    .ensureAlpha()
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                return (col: number, row: number) => {
                    const i = (row * 257 + col) * 4;
                    return data[i]! * 256 + data[i + 1]! + data[i + 2]! / 256 - 32768;
                };
            };
            const [west, east, pole] = await Promise.all([decode(0, 1, 0, 0), decode(0, 1, 1, 0), decode(4, 0, 0, 0)]);
            for (let y = 0; y <= 256; y++) expect(west(256, y)).toBe(east(0, y));
            expect(east(0, 256)).toBeLessThan(0);
            expect(Number.isFinite(pole(128, 128))).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

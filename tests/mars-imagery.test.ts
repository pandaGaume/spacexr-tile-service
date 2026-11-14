import { describe, expect, it } from "vitest";
import { borderHashes, verifyGlobalBorders } from "../tools/lunar/global-kernel";
import { reduceWindow, type IRgbLevel } from "../tools/mars/imagery/area-pyramid";
import { sampleTile, sourceWindow, TILE_SIZE } from "../tools/mars/imagery/cube-area-sampler";
import type { IPlateCarree } from "../tools/mars/imagery/moric";

const RADIUS = 3396190;
/** A whole-planet raster of 360 by 180 pixels, one degree each. */
function planet(value: (column: number, row: number, channel: number) => number): {
    geometry: IPlateCarree;
    base: IRgbLevel;
} {
    const width = 360,
        height = 180,
        pixelMetres = (2 * Math.PI * RADIUS) / width;
    const data = new Uint8Array(width * height * 3);
    for (let row = 0; row < height; row++)
        for (let column = 0; column < width; column++)
            for (let channel = 0; channel < 3; channel++)
                data[(row * width + column) * 3 + channel] = value(column, row, channel);
    return {
        geometry: {
            width,
            height,
            originX: -Math.PI * RADIUS,
            originY: (Math.PI / 2) * RADIUS,
            pixelMetres,
            sphereRadius: RADIUS,
        },
        base: { k: 0, row0: 0, col0: 0, rows: height, cols: width, data },
    };
}

describe("Mars imagery from an area pyramid", () => {
    it("averages every level from the source pixels, edge blocks included", () => {
        const { geometry, base } = planet((column, row, channel) => (column * 7 + row * 13 + channel * 29) % 256);
        const levels = reduceWindow(geometry, base, 3);
        for (const level of levels) {
            const size = 2 ** level.k;
            for (const [row, column] of [
                [0, 0],
                [level.rows - 1, level.cols - 1],
                [3, 17],
            ] as const) {
                let sum = 0,
                    count = 0;
                for (let r = row * size; r < Math.min(geometry.height, (row + 1) * size); r++)
                    for (let c = column * size; c < Math.min(geometry.width, (column + 1) * size); c++) {
                        sum += base.data[(r * geometry.width + c) * 3 + 1]!;
                        count++;
                    }
                expect(level.data[(row * level.cols + column) * 3 + 1]).toBe(Math.floor(sum / count + 0.5));
            }
        }
    });

    it("samples a uniform source as itself and shares every border of a level, across faces and the seam", () => {
        const uniform = planet((_, __, channel) => 40 + channel);
        const flat = sampleTile({ face: 4, lod: 0, x: 0, y: 0 }, uniform.geometry, new Map([[0, uniform.base]]), 0);
        expect(new Set(flat.filter((_, i) => i % 3 === 0))).toEqual(new Set([40]));

        const { geometry, base } = planet((column, row, channel) => (column + 2 * row + 50 * channel) % 256);
        const levels = new Map<number, IRgbLevel>([
            [0, base],
            ...reduceWindow(geometry, base, 3).map((l) => [l.k, l] as const),
        ]);
        const files = [];
        for (let face = 0; face < 6; face++)
            for (let y = 0; y < 2; y++)
                for (let x = 0; x < 2; x++) {
                    const address = { face, lod: 1, x, y };
                    const rgb = sampleTile(address, geometry, levels, 3);
                    files.push({ kind: "imagery" as const, address, borders: borderHashes(rgb, 3, TILE_SIZE + 1) });
                }
        expect(verifyGlobalBorders(files)).toBe(48);
    });

    it("plans a source window that holds every footprint of its tiles", () => {
        const { geometry } = planet(() => 0);
        const window = sourceWindow([{ face: 1, lod: 2, x: 1, y: 1 }], geometry, 0, 2);
        expect(window.row0 % 4).toBe(0);
        expect(window.col0 % 4).toBe(0);
        expect(window.cols).toBeLessThan(geometry.width);
        const polar = sourceWindow([{ face: 4, lod: 1, x: 0, y: 0 }], geometry, 0, 2);
        expect(polar).toMatchObject({ col0: 0, cols: geometry.width, row0: 0 });
    });
});

import { describe, expect, it } from "vitest";
import { createHeightGrid, encodeTerrariumGrid, terrariumHeight } from "@spacexr/dem";
import { elevationGrid, sampleElevationMetres, validateElevationRaster } from "../tools/r2/lunar-dem";

describe("numeric lunar DEM processing", () => {
    const raster = { width: 4, height: 2, kilometres: new Float32Array([1, 2, 3, 4, -1, -2, -3, -4]) };
    it("converts numeric kilometres to metres at source pixel centres", () => {
        validateElevationRaster(raster);
        expect(sampleElevationMetres(raster, 45, -135)).toBe(1000);
        expect(sampleElevationMetres(raster, -45, -135)).toBe(-1000);
        expect(sampleElevationMetres(raster, 0, -135)).toBe(0);
    });
    it("wraps the date line and makes every longitude at a pole coincide", () => {
        expect(sampleElevationMetres(raster, 20, -180)).toBe(sampleElevationMetres(raster, 20, 180));
        expect(sampleElevationMetres(raster, 90, 0)).toBe(2500);
        expect(sampleElevationMetres(raster, 90, 135)).toBe(2500);
        expect(sampleElevationMetres(raster, -90, -80)).toBe(-2500);
    });
    it("keeps every shared vertex border identical, including the global seam", () => {
        const grids = Array.from({ length: 4 }, (_, x) => elevationGrid(raster, { z: 1, x, y: 0 }));
        const south = elevationGrid(raster, { z: 1, x: 0, y: 1 });
        for (let row = 0; row <= 256; row++)
            for (let x = 0; x < 4; x++) expect(grids[x][row * 257 + 256]).toBe(grids[(x + 1) % 4][row * 257]);
        for (let column = 0; column <= 256; column++) expect(grids[0][256 * 257 + column]).toBe(south[column]);
    });
    it("roundtrips physical heights through the public DEM Terrarium encoder", () => {
        const grid = elevationGrid(raster, { z: 0, x: 0, y: 0 });
        const image = encodeTerrariumGrid(createHeightGrid(257, 257, grid));
        for (let index = 0; index < grid.length; index++) {
            const offset = index * 4;
            const height = terrariumHeight(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
            expect(Math.abs(height - grid[index])).toBeLessThanOrEqual(1 / 512);
        }
    });
    it("rejects corrupt rasters and impossible coordinates", () => {
        expect(() => validateElevationRaster({ ...raster, kilometres: new Float32Array([NaN]) })).toThrow();
        expect(() => validateElevationRaster({ ...raster, kilometres: new Float32Array(8).fill(1000) })).toThrow();
        expect(() => sampleElevationMetres(raster, 91, 0)).toThrow();
    });
});

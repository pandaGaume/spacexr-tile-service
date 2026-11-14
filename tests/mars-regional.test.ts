import { describe, expect, it } from "vitest";
import { deepestLevel, MARS_REGIONS, regionLevels } from "../tools/mars/regional-refinement";

describe("regional refinement levels", () => {
    it("ends each source at the deepest level whose samples are not finer than its own", () => {
        // A level-0 sample spans a quarter turn of the 3396190 m sphere over 256 samples, about 20839 m.
        expect(deepestLevel(20)).toBe(10);
        expect(deepestLevel(3.5)).toBe(12);
        expect(deepestLevel(1)).toBe(14);
        expect(deepestLevel(20000)).toBe(0);
    });

    it("starts the first source below the global MOLA levels and each next one below the previous", () => {
        expect(regionLevels([20, 1])).toEqual([
            { minLOD: 5, maxLOD: 10 },
            { minLOD: 11, maxLOD: 14 },
        ]);
        expect(regionLevels([3.5])).toEqual([{ minLOD: 5, maxLOD: 12 }]);
    });

    it("refuses a source that adds no level", () => {
        expect(() => regionLevels([1, 1])).toThrow(/adds no level/);
        expect(() => regionLevels([5000])).toThrow(/adds no level/);
    });

    it("gives every region and source a distinct identifier", () => {
        const regions = MARS_REGIONS.map((region) => region.id);
        expect(new Set(regions).size).toBe(regions.length);
        const sources = MARS_REGIONS.flatMap((region) => region.sources.map((source) => source.id));
        expect(new Set(sources).size).toBe(sources.length);
    });
});

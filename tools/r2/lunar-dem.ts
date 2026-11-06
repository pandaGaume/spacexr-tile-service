import { vertexAtDegrees, type IGeographicTileAddress } from "@spacexr-service/tile2d-core";

/** North-west, pixel-centred, global cylindrical raster. Values are LOLA heights in kilometres. */
export interface ILunarElevationRaster {
    width: number;
    height: number;
    kilometres: Float32Array;
}
/** Validate a decoded scalar raster without silently converting missing heights to zero. */
export function validateElevationRaster(raster: ILunarElevationRaster): void {
    if (
        !Number.isInteger(raster.width) ||
        raster.width < 2 ||
        raster.height < 2 ||
        raster.width !== raster.height * 2 ||
        raster.kilometres.length !== raster.width * raster.height
    )
        throw new Error("Expected a global 2:1 scalar DEM raster");
    for (const value of raster.kilometres)
        if (!Number.isFinite(value) || Math.abs(value) > 30) throw new Error("Invalid lunar elevation in kilometres");
}
/** Bilinear sampling in metres. Longitude wraps; latitude clamps to the nearest source row. */
export function sampleElevationMetres(raster: ILunarElevationRaster, latitude: number, longitude: number): number {
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude))
        throw new RangeError("Invalid geographic position");
    const longitudeWrapped = (((longitude + 180) % 360) + 360) % 360;
    const x = (longitudeWrapped / 360) * raster.width - 0.5;
    const y = Math.max(0, Math.min(raster.height - 1, ((90 - latitude) / 180) * raster.height - 0.5));
    const left = Math.floor(x),
        top = Math.floor(y),
        fx = x - left,
        fy = y - top;
    const at = (column: number, row: number): number =>
        raster.kilometres[
            Math.min(row, raster.height - 1) * raster.width + (((column % raster.width) + raster.width) % raster.width)
        ];
    // Every longitude at an exact pole denotes the same position. Use the polar row mean there.
    if (Math.abs(latitude) === 90) {
        let sum = 0;
        const row = latitude > 0 ? 0 : raster.height - 1;
        for (let column = 0; column < raster.width; column++) sum += at(column, row);
        return (sum / raster.width) * 1000;
    }
    return (
        ((at(left, top) * (1 - fx) + at(left + 1, top) * fx) * (1 - fy) +
            (at(left, top + 1) * (1 - fx) + at(left + 1, top + 1) * fx) * fy) *
        1000
    );
}
/** Shared integer lattice gives neighbouring 257-square tiles bit-identical border heights. */
export function elevationGrid(raster: ILunarElevationRaster, address: IGeographicTileAddress): Float32Array {
    const data = new Float32Array(257 * 257);
    for (let row = 0; row <= 256; row++)
        for (let column = 0; column <= 256; column++) {
            const point = vertexAtDegrees(address, column, row);
            data[row * 257 + column] = sampleElevationMetres(raster, point.latitude, point.longitude);
        }
    return data;
}

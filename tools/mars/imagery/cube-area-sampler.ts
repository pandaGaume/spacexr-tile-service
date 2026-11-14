import type { ITileAddress } from "@spacexr/tiles/addressing";
import { CUBE_FACE_FRAMES } from "@spacexr/tiles/cube";
import type { IRgbLevel } from "./area-pyramid";
import type { IPlateCarree } from "./moric";

/** Cells per tile side: imagery tiles hold `TILE_SIZE + 1` samples per side, their edges shared with their neighbours. */
export const TILE_SIZE = 256;
const SIDE = TILE_SIZE + 1;

/**
 * Area of a vertex of a cube tile: its planetocentric latitude and east longitude, in radians, the directions the
 * elevation tiles sample, and the side of the square it averages, in metres. The side is the square root of the area of one cell
 * of the tile at the vertex, on the sphere of the source: it depends on the vertex and the level only, so the two tiles
 * that share a vertex average the same area.
 */
export interface IVertexFootprint {
    latitude: number;
    longitude: number;
    side: number;
}

/**
 * Calls `visit` for each of the `257 x 257` vertices of a tile, row by row. A vertex is the point
 * `centre + tan(a) u + tan(b) v` of its face, the equi-angular mapping of the cube index, built from the unit axes of the
 * face so that its components are exact: the faces that share a vertex give it the same bits, and the same footprint.
 */
export function forEachVertex(
    address: ITileAddress,
    radius: number,
    visit: (index: number, footprint: IVertexFootprint) => void,
): void {
    const count = 2 ** address.lod;
    const frame = CUBE_FACE_FRAMES[address.face ?? 0]!;
    const cellAngle = Math.PI / (2 * TILE_SIZE * count);
    const denominator = TILE_SIZE * count;
    // The ends of a face are exactly -1 and 1, where tan(pi / 4) is not.
    const tangents = (origin: number) =>
        Float64Array.from({ length: SIDE }, (_, i) => {
            const numerator = origin * TILE_SIZE + i;
            return numerator === 0
                ? -1
                : numerator === denominator
                  ? 1
                  : Math.tan((Math.PI / 4) * ((2 * numerator) / denominator - 1));
        });
    const tu = tangents(address.x),
        tv = tangents(address.y);
    const footprint: IVertexFootprint = { latitude: 0, longitude: 0, side: 0 };
    for (let row = 0; row < SIDE; row++) {
        const v = tv[row]!,
            b = v * v;
        for (let column = 0; column < SIDE; column++) {
            const u = tu[column]!,
                a = u * u;
            const x = frame.center.x + frame.u.x * u + frame.v.x * v;
            const y = frame.center.y + frame.u.y * u + frame.v.y * v;
            const z = frame.center.z + frame.u.z * u + frame.v.z * v;
            footprint.latitude = Math.atan2(z, Math.hypot(x, y));
            // A signed zero would turn the seam into -pi on one face and pi on the other.
            footprint.longitude = x === 0 && y === 0 ? 0 : Math.atan2(y === 0 ? 0 : y, x === 0 ? 0 : x);
            // Area of the cell of an equi-angular face at the vertex, over the area of the same angles at its centre.
            const jacobian = ((1 + a) * (1 + b)) / (1 + a + b) ** 1.5;
            footprint.side = radius * cellAngle * Math.sqrt(jacobian);
            visit(row * SIDE + column, footprint);
        }
    }
}

/** Pixel rectangle of level `k` that a footprint covers, in fractional pixels, with its longitude split at the seam. */
export interface IPixelBox {
    k: number;
    top: number;
    bottom: number;
    /** One or two column spans, west to east, each within the level. */
    spans: Array<[number, number]>;
    /** Whether the footprint covers whole rows, at a pole or wider than the planet. */
    wholeRow: boolean;
}

/**
 * The pyramid level whose pixel is the largest not exceeding the footprint, and the pixels the footprint covers there.
 * The square is taken in latitude and longitude: its longitude extent widens with `1 / cos(latitude)` and covers the
 * whole row at the poles. Rows outside the raster are dropped; a footprint wholly outside it takes the nearest row.
 */
export function pixelBox(geometry: IPlateCarree, footprint: IVertexFootprint, maxK: number): IPixelBox {
    const { latitude, longitude, side } = footprint;
    const r = geometry.sphereRadius;
    const k = Math.max(0, Math.min(maxK, Math.floor(Math.log2(side / geometry.pixelMetres))));
    const pixel = geometry.pixelMetres * 2 ** k;
    const half = side / (2 * r);
    const north = Math.min(Math.PI / 2, latitude + half),
        south = Math.max(-Math.PI / 2, latitude - half);
    const dataRows = geometry.height / 2 ** k;
    let top = Math.max(0, (geometry.originY - north * r) / pixel),
        bottom = Math.min(dataRows, (geometry.originY - south * r) / pixel);
    if (top >= dataRows) [top, bottom] = [Math.ceil(dataRows) - 1, Math.min(dataRows, Math.ceil(dataRows))];
    else if (bottom <= 0) [top, bottom] = [0, Math.min(1, dataRows)];
    const circumference = 2 * Math.PI * r;
    const cosine = Math.cos(latitude);
    const width = cosine * Math.PI > half ? (2 * half * r) / cosine : circumference;
    const spans: Array<[number, number]> = [];
    const wholeRow = width >= circumference;
    if (wholeRow) spans.push([0, circumference / pixel]);
    else {
        const west = (((longitude * r - width / 2 - geometry.originX) % circumference) + circumference) % circumference;
        const east = west + width;
        if (east <= circumference) spans.push([west / pixel, east / pixel]);
        else spans.push([west / pixel, circumference / pixel], [0, (east - circumference) / pixel]);
    }
    return { k, top, bottom, spans, wholeRow };
}

/**
 * Samples the `257 x 257` RGB vertices of a cube tile from area pyramid windows: each vertex is the mean of the source
 * over its footprint, every pixel weighted by the part of it the footprint covers.
 *
 * @param levels - Windows by level; each must hold every pixel the tile needs at that level.
 * @throws Error When a footprint needs a level or a pixel the windows do not hold.
 */
export function sampleTile(
    address: ITileAddress,
    geometry: IPlateCarree,
    levels: ReadonlyMap<number, IRgbLevel>,
    maxK: number,
): Uint8Array {
    const rgb = new Uint8Array(SIDE * SIDE * 3);
    forEachVertex(address, geometry.sphereRadius, (index, footprint) => {
        const box = pixelBox(geometry, footprint, maxK);
        const level = levels.get(box.k);
        if (!level)
            throw new Error(`Tile ${address.face}/${address.lod}/${address.x}/${address.y} needs level ${box.k}.`);
        let red = 0,
            green = 0,
            blue = 0,
            total = 0;
        for (let row = Math.floor(box.top); row < box.bottom; row++) {
            const weightY = Math.min(row + 1, box.bottom) - Math.max(row, box.top);
            const localRow = row - level.row0;
            if (localRow < 0 || localRow >= level.rows)
                throw new Error(`Row ${row} of level ${box.k} is outside its window.`);
            for (const [west, east] of box.spans)
                for (let column = Math.floor(west); column < east; column++) {
                    const weight = weightY * (Math.min(column + 1, east) - Math.max(column, west));
                    if (weight <= 0) continue;
                    const localColumn = column - level.col0;
                    if (localColumn < 0 || localColumn >= level.cols)
                        throw new Error(`Column ${column} of level ${box.k} is outside its window.`);
                    const i = (localRow * level.cols + localColumn) * 3;
                    red += level.data[i]! * weight;
                    green += level.data[i + 1]! * weight;
                    blue += level.data[i + 2]! * weight;
                    total += weight;
                }
        }
        rgb[index * 3] = Math.round(red / total);
        rgb[index * 3 + 1] = Math.round(green / total);
        rgb[index * 3 + 2] = Math.round(blue / total);
    });
    return rgb;
}

/**
 * Level 0 rows and columns that the footprints of `addresses` need, for every level up to `maxK`, aligned on blocks of
 * `2^alignK` and clamped to the raster. `columns` is `undefined` when the footprints cross the seam or a pole: the
 * whole rows are then needed.
 */
export function sourceWindow(
    addresses: readonly ITileAddress[],
    geometry: IPlateCarree,
    maxK: number,
    alignK: number,
): { row0: number; rows: number; col0: number; cols: number } {
    let top = Infinity,
        bottom = -Infinity,
        west = Infinity,
        east = -Infinity,
        wholeRows = false;
    for (const address of addresses)
        forEachVertex(address, geometry.sphereRadius, (_, footprint) => {
            const box = pixelBox(geometry, footprint, maxK);
            const scale = 2 ** box.k;
            top = Math.min(top, Math.floor(box.top) * scale);
            bottom = Math.max(bottom, Math.ceil(box.bottom) * scale);
            if (box.wholeRow || box.spans.length !== 1) wholeRows = true;
            for (const [w, e] of box.spans) {
                west = Math.min(west, Math.floor(w) * scale);
                east = Math.max(east, Math.ceil(e) * scale);
            }
        });
    const block = 2 ** alignK;
    const row0 = Math.floor(top / block) * block;
    const rowEnd = Math.min(geometry.height, Math.ceil(bottom / block) * block);
    if (wholeRows) return { row0, rows: rowEnd - row0, col0: 0, cols: geometry.width };
    const col0 = Math.floor(west / block) * block;
    const colEnd = Math.min(geometry.width, Math.ceil(east / block) * block);
    return { row0, rows: rowEnd - row0, col0, cols: colEnd - col0 };
}

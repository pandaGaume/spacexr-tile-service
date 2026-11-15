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
 * Pyramid windows that hold the pixels a sampler reads: the window of level `k` holding a column of that level, or
 * `undefined` when none does.
 */
export type LevelLookup = (k: number, column: number) => IRgbLevel | undefined;

/** A lookup over whole levels, or over windows that each hold the whole width a tile needs. */
export function levelsLookup(levels: ReadonlyMap<number, IRgbLevel>): LevelLookup {
    return (k) => levels.get(k);
}

/**
 * Samples the `257 x 257` RGB vertices of a cube tile from area pyramid windows: each vertex is the mean of the source
 * over its footprint, every pixel weighted by the part of it the footprint covers.
 *
 * @param levelAt - The windows; each pixel a footprint needs must be in the window returned for its column.
 * @throws Error When a footprint needs a pixel the windows do not hold.
 */
export function sampleTile(
    address: ITileAddress,
    geometry: IPlateCarree,
    levelAt: LevelLookup,
    maxK: number,
): Uint8Array {
    const rgb = new Uint8Array(SIDE * SIDE * 3);
    forEachVertex(address, geometry.sphereRadius, (index, footprint) => {
        const box = pixelBox(geometry, footprint, maxK);
        let red = 0,
            green = 0,
            blue = 0,
            total = 0;
        let level: IRgbLevel | undefined;
        for (let row = Math.floor(box.top); row < box.bottom; row++) {
            const weightY = Math.min(row + 1, box.bottom) - Math.max(row, box.top);
            for (const [west, east] of box.spans)
                for (let column = Math.floor(west); column < east; column++) {
                    const weight = weightY * (Math.min(column + 1, east) - Math.max(column, west));
                    if (weight <= 0) continue;
                    if (!level || column < level.col0 || column >= level.col0 + level.cols)
                        level = levelAt(box.k, column);
                    const localRow = row - (level?.row0 ?? 0),
                        localColumn = column - (level?.col0 ?? 0);
                    if (
                        !level ||
                        localRow < 0 ||
                        localRow >= level.rows ||
                        localColumn < 0 ||
                        localColumn >= level.cols
                    )
                        throw new Error(
                            `Tile ${address.face}/${address.lod}/${address.x}/${address.y} needs pixel ${column}, ${row} of level ${box.k}.`,
                        );
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

/** Source columns per block of {@link sourceBlocks}. */
export const SOURCE_BLOCK = 256;

/**
 * Level 0 windows that hold every pixel the footprints of `addresses` need, at every level up to `maxK`: one per block
 * of {@link SOURCE_BLOCK} columns that a footprint reaches, with the rows needed in that block, aligned on `2^alignK`
 * and clamped to the raster. Tiles across the seam or near a pole read only the blocks and rows they need.
 */
export function sourceBlocks(
    addresses: readonly ITileAddress[],
    geometry: IPlateCarree,
    maxK: number,
    alignK: number,
): Array<{ row0: number; rows: number; col0: number; cols: number }> {
    const count = Math.ceil(geometry.width / SOURCE_BLOCK);
    const top = new Float64Array(count).fill(Infinity),
        bottom = new Float64Array(count).fill(-Infinity);
    for (const address of addresses)
        forEachVertex(address, geometry.sphereRadius, (_, footprint) => {
            const box = pixelBox(geometry, footprint, maxK);
            const scale = 2 ** box.k;
            const rowTop = Math.floor(box.top) * scale,
                rowBottom = Math.ceil(box.bottom) * scale;
            for (const [west, east] of box.spans) {
                const first = Math.floor((Math.floor(west) * scale) / SOURCE_BLOCK);
                const last = Math.min(count - 1, Math.floor((Math.ceil(east) * scale - 1) / SOURCE_BLOCK));
                for (let block = first; block <= last; block++) {
                    if (rowTop < top[block]!) top[block] = rowTop;
                    if (rowBottom > bottom[block]!) bottom[block] = rowBottom;
                }
            }
        });
    const align = 2 ** alignK;
    const windows = [];
    for (let block = 0; block < count; block++) {
        if (top[block] === Infinity) continue;
        const row0 = Math.floor(top[block]! / align) * align;
        const rowEnd = Math.min(geometry.height, Math.ceil(bottom[block]! / align) * align);
        const col0 = block * SOURCE_BLOCK;
        windows.push({ row0, rows: rowEnd - row0, col0, cols: Math.min(geometry.width, col0 + SOURCE_BLOCK) - col0 });
    }
    return windows;
}

/** A lookup over the reduced windows of {@link sourceBlocks}, keyed by block. */
export function blocksLookup(blocks: ReadonlyMap<number, ReadonlyMap<number, IRgbLevel>>): LevelLookup {
    return (k, column) => blocks.get(k)?.get(Math.floor((column * 2 ** k) / SOURCE_BLOCK));
}

import type { IPlateCarree } from "./moric";

/**
 * A window of one level of the area pyramid of a Plate Carree raster. Level `k` averages blocks of `2^k` by `2^k`
 * source pixels, aligned on the first pixel of the raster; a block cut by the east or south edge averages the pixels it
 * holds. Rows and columns are those of the whole level, the window holding `rows` by `cols` of them.
 */
export interface IRgbLevel {
    k: number;
    row0: number;
    col0: number;
    rows: number;
    cols: number;
    /** RGB, row by row. */
    data: Uint8Array;
}

/** Columns and rows of level `k` of a raster. */
export function levelSize(geometry: Pick<IPlateCarree, "width" | "height">, k: number) {
    return { width: Math.ceil(geometry.width / 2 ** k), height: Math.ceil(geometry.height / 2 ** k) };
}

/**
 * Reduces a window of level 0 into levels 1 to `depth`, from exact integer sums of the source pixels: every level is
 * rounded once, from the source, never from a rounded level.
 *
 * @param base - Level 0 window, starting on a multiple of `2^depth` and ending on one or on the raster edge.
 * @returns Levels 1 to `depth`, in order.
 */
export function reduceWindow(
    geometry: Pick<IPlateCarree, "width" | "height">,
    base: IRgbLevel,
    depth: number,
): IRgbLevel[] {
    const block = 2 ** depth;
    if (base.k !== 0) throw new Error("The window to reduce must be level 0.");
    if (base.row0 % block || base.col0 % block) throw new Error(`The window must start on a multiple of ${block}.`);
    const rowEnd = base.row0 + base.rows,
        colEnd = base.col0 + base.cols;
    if ((rowEnd % block && rowEnd !== geometry.height) || (colEnd % block && colEnd !== geometry.width))
        throw new Error(`The window must end on a multiple of ${block} or on the raster edge.`);
    const levels: IRgbLevel[] = [];
    let sums: Uint8Array | Uint32Array = base.data,
        rows = base.rows,
        cols = base.cols;
    for (let k = 1; k <= depth; k++) {
        const nextRows = Math.ceil(rows / 2),
            nextCols = Math.ceil(cols / 2);
        const next = new Uint32Array(nextRows * nextCols * 3);
        for (let r = 0; r < rows; r++) {
            const source = r * cols * 3,
                target = (r >> 1) * nextCols * 3;
            for (let c = 0; c < cols; c++) {
                const s = source + c * 3,
                    t = target + (c >> 1) * 3;
                next[t] += sums[s]!;
                next[t + 1] += sums[s + 1]!;
                next[t + 2] += sums[s + 2]!;
            }
        }
        const row0 = base.row0 / 2 ** k,
            col0 = base.col0 / 2 ** k,
            data = new Uint8Array(next.length);
        for (let r = 0; r < nextRows; r++) {
            const height = Math.min(geometry.height, (row0 + r + 1) * 2 ** k) - (row0 + r) * 2 ** k;
            for (let c = 0; c < nextCols; c++) {
                const count = height * (Math.min(geometry.width, (col0 + c + 1) * 2 ** k) - (col0 + c) * 2 ** k);
                const i = (r * nextCols + c) * 3;
                for (let channel = 0; channel < 3; channel++)
                    data[i + channel] = Math.floor((2 * next[i + channel]! + count) / (2 * count));
            }
        }
        levels.push({ k, row0, col0, rows: nextRows, cols: nextCols, data });
        sums = next;
        rows = nextRows;
        cols = nextCols;
    }
    return levels;
}

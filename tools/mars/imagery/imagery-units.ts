import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import type { ITileAddress } from "@spacexr/tiles/addressing";
import { borderHashes } from "../../lunar/global-kernel";
import { sha256 } from "../../lunar/storage";
import { TILE_SIZE } from "./cube-area-sampler";
import type { IPlateCarree } from "./moric";

/** One imagery tile of a Mars imagery revision. */
export interface IMarsImageryFile {
    kind: "imagery";
    address: { face: number; lod: number; x: number; y: number };
    path: string;
    bytes: number;
    sha256: string;
    /** Hashes of the four edges, forward and reversed, for the shared border check; not kept in manifests. */
    borders?: string[];
    source: string;
}

/** Input of a worker that builds units: a tile below the global levels and every tile below it. */
export interface IUnitWorkerData {
    file: string;
    geometry: IPlateCarree;
    work: string;
    source: string;
    /** Deepest level of the units. */
    maxLOD: number;
    /**
     * Coarsest pyramid level the footprints of a unit read, reduced from its source windows, which start on rows of
     * multiples of `2^alignK`.
     */
    alignK: number;
}

/** Tiles of a unit and, by level, the histogram of their differences with their parents. */
export interface IUnitResult {
    files: IMarsImageryFile[];
    histograms: Record<number, number[]>;
}

export const imageryTileKey = ({ face, lod, x, y }: ITileAddress): string => `${face ?? 0}/${lod}/${x}/${y}`;

/** A tile and every tile below it down to `maxLOD`, parents before children. */
export function descendants(root: ITileAddress, maxLOD: number): ITileAddress[] {
    const tiles: ITileAddress[] = [root];
    for (let i = 0; i < tiles.length; i++) {
        const { face, lod, x, y } = tiles[i]!;
        if (lod < maxLOD)
            for (let child = 0; child < 4; child++)
                tiles.push({ face, lod: lod + 1, x: 2 * x + (child & 1), y: 2 * y + (child >> 1) });
    }
    return tiles;
}

/**
 * Adds to `histogram` the largest absolute channel difference between a tile and its parent at each sample they share.
 */
export function parentHistogram(
    address: ITileAddress,
    child: Uint8Array,
    parent: Uint8Array,
    histogram: number[],
): void {
    const offsetX = (address.x & 1) * (TILE_SIZE / 2),
        offsetY = (address.y & 1) * (TILE_SIZE / 2);
    for (let row = 0; row <= TILE_SIZE; row += 2)
        for (let column = 0; column <= TILE_SIZE; column += 2) {
            const c = (row * (TILE_SIZE + 1) + column) * 3;
            const p = ((offsetY + row / 2) * (TILE_SIZE + 1) + offsetX + column / 2) * 3;
            histogram[
                Math.max(
                    Math.abs(child[c]! - parent[p]!),
                    Math.abs(child[c + 1]! - parent[p + 1]!),
                    Math.abs(child[c + 2]! - parent[p + 2]!),
                )
            ]!++;
        }
}

/** Median, 95th percentile and maximum of a histogram of the values 0 to 255. */
export function histogramSummary(histogram: readonly number[]): { median: number; p95: number; max: number } {
    const total = histogram.reduce((sum, count) => sum + count, 0);
    const at = (fraction: number): number => {
        let seen = 0;
        for (let value = 0; value < histogram.length; value++) {
            seen += histogram[value]!;
            if (seen > fraction * total) return value;
        }
        return histogram.length - 1;
    };
    let max = 0;
    for (let value = 0; value < histogram.length; value++) if (histogram[value]) max = value;
    return { median: at(0.5), p95: at(0.95), max };
}

/** Encodes a tile as lossless WebP in a work directory and describes it. */
export async function writeImageryTile(
    work: string,
    address: ITileAddress,
    rgb: Uint8Array,
    source: string,
): Promise<IMarsImageryFile> {
    const bytes = await sharp(rgb, { raw: { width: TILE_SIZE + 1, height: TILE_SIZE + 1, channels: 3 } })
        .webp({ lossless: true, effort: 0 })
        .toBuffer();
    const path = `imagery/${imageryTileKey(address)}.webp`;
    const target = resolve(work, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return {
        kind: "imagery",
        address: { face: address.face ?? 0, lod: address.lod, x: address.x, y: address.y },
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
        borders: borderHashes(rgb, 3, TILE_SIZE + 1),
        source,
    };
}

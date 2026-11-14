import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import { fromFile } from "geotiff";
import type { ITileAddress } from "@spacexr/tiles/addressing";
import { cubeTileOfDirection } from "@spacexr/tiles/cube";
import { planetocentricDirection } from "@spacexr/tiles/surface";
import { borderHashes, verifyGlobalBorders } from "../../lunar/global-kernel";
import { sha256, storagePath, writeJson } from "../../lunar/storage";
import { FRAME, MARS_2000, marsSubtrees } from "../global-cube";
import { reduceWindow, type IRgbLevel } from "./area-pyramid";
import { forEachVertex, pixelBox, sampleTile, sourceWindow, TILE_SIZE } from "./cube-area-sampler";
import { MORIC, moricSourceManifest, type IPlateCarree } from "./moric";
import { loadPyramidLevel, moricPyramid, PYRAMID_MAX_K, PYRAMID_MIN_K } from "./moric-pyramid";

/** A region of the imagery below the global levels, as a longitude and latitude box in degrees. */
export interface IImageryWindow {
    id: string;
    west: number;
    east: number;
    south: number;
    north: number;
}

/** Windows of MoRIC below its global levels: Jezero, the extent of its CTX orthomosaic. */
export const MORIC_WINDOWS: readonly IImageryWindow[] = [
    { id: "jezero", west: 77.0, east: 78.6, south: 17.6, north: 19.3 },
];

/** One imagery tile of a Mars imagery revision. */
export interface IMarsImageryFile {
    kind: "imagery";
    address: { face: number; lod: number; x: number; y: number };
    path: string;
    bytes: number;
    sha256: string;
    borders: string[];
    source: string;
}

/** Manifest of a Mars imagery revision. */
export interface IMarsImageryManifest {
    schema: "mars-imagery/1";
    revision: string;
    status: "verified";
    /** Levels available everywhere. */
    maxLOD: number;
    tileSize: number;
    frame: string;
    referenceRadii: readonly [number, number, number];
    createdAt: string;
    sources: Array<{
        id: string;
        url: string;
        credit: string;
        rights: string;
        sha256: string;
        resolutionMetres: number;
        minLOD: number;
        maxLOD: number;
        windows: IImageryWindow[];
        tiles: number;
    }>;
    /**
     * Each tile against its parent at the samples they share, by level: the median and 95th percentile of the largest
     * absolute difference of the three channels. A parent averages four times the area of its child, so the difference
     * measures the detail a level adds; a misplaced or shifted tile shows as an outlier.
     */
    parentDifference: Array<{ lod: number; median: number; p95: number; max: number }>;
    files: IMarsImageryFile[];
    sharedBordersVerified: number;
    bytes: number;
}

const tileKey = ({ face, lod, x, y }: ITileAddress): string => `${face}/${lod}/${x}/${y}`;

/** Smallest pyramid level a vertex of `lod` reads, over every vertex of a face. */
function minimumLevel(geometry: IPlateCarree, lod: number): number {
    let minimum = Infinity;
    // The footprint shrinks from the centre of a face to its corners, alike at the four of them: the tile holding one
    // corner holds the smallest.
    forEachVertex({ face: 0, lod, x: 0, y: 0 }, geometry.sphereRadius, (_, footprint) => {
        minimum = Math.min(minimum, pixelBox(geometry, footprint, PYRAMID_MAX_K).k);
    });
    return minimum;
}

/** Deepest level whose nominal pixel, at the centre of a face, is not finer than the source pixel. */
export function deepestLevel(geometry: IPlateCarree): number {
    const nominal = (geometry.sphereRadius * Math.PI) / (2 * TILE_SIZE);
    return Math.floor(Math.log2(nominal / geometry.pixelMetres));
}

/** Tiles of `lod` that contain a point of a window, on a grid finer than a tile of that level. */
function windowTiles(window: IImageryWindow, lod: number): ITileAddress[] {
    const tiles = new Map<string, ITileAddress>();
    const step = 90 / 2 ** lod / 16;
    for (let latitude = window.south; latitude <= window.north + step / 2; latitude += step)
        for (let longitude = window.west; longitude <= window.east + step / 2; longitude += step) {
            const address = cubeTileOfDirection(
                planetocentricDirection(Math.min(latitude, window.north), Math.min(longitude, window.east)),
                lod,
            );
            tiles.set(tileKey(address), address);
        }
    return [...tiles.values()];
}

function descendants(root: ITileAddress, maxLOD: number): ITileAddress[] {
    const tiles: ITileAddress[] = [root];
    for (let i = 0; i < tiles.length; i++) {
        const { face, lod, x, y } = tiles[i]!;
        if (lod < maxLOD)
            for (let child = 0; child < 4; child++)
                tiles.push({ face, lod: lod + 1, x: 2 * x + (child & 1), y: 2 * y + (child >> 1) });
    }
    return tiles;
}

function percentile(sorted: Uint8Array | number[], p: number): number {
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0;
}

/**
 * Builds a Mars imagery revision from Tianwen-1 MoRIC: every tile of the levels whose footprints the stored pyramid
 * holds, then, below them, every tile down to the deepest level of the source inside each window. Each sample is the
 * area mean of the source over its cell. Writes `datasets/mars/imagery-<revision>/` with `imagery.json` and its
 * manifest, then `catalog/latest-imagery.json`.
 */
export async function buildMoricImagery(
    root: string,
    windows: readonly IImageryWindow[] = MORIC_WINDOWS,
): Promise<string> {
    const source = await moricSourceManifest(root);
    const geometry = source.geometry;
    await moricPyramid(root, source);
    const deepest = deepestLevel(geometry);
    let globalMaxLOD = 0;
    while (globalMaxLOD < deepest && minimumLevel(geometry, globalMaxLOD + 1) >= PYRAMID_MIN_K) globalMaxLOD++;
    console.log(
        `MoRIC: levels 0-${globalMaxLOD} everywhere, ${globalMaxLOD + 1}-${deepest} in ${windows.map((w) => w.id).join(", ")}.`,
    );

    const work = storagePath(root, `work/mars-imagery-${randomUUID()}`);
    const files: IMarsImageryFile[] = [];
    const rgbs = new Map<string, Uint8Array>();
    const write = async (address: ITileAddress, rgb: Uint8Array): Promise<void> => {
        const bytes = await sharp(rgb, { raw: { width: TILE_SIZE + 1, height: TILE_SIZE + 1, channels: 3 } })
            .webp({ lossless: true, effort: 0 })
            .toBuffer();
        const path = `imagery/${tileKey(address)}.webp`;
        const target = resolve(work, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        files.push({
            kind: "imagery",
            address: { face: address.face ?? 0, lod: address.lod, x: address.x, y: address.y },
            path,
            bytes: bytes.length,
            sha256: sha256(bytes),
            borders: borderHashes(rgb, 3, TILE_SIZE + 1),
            source: MORIC.id,
        });
        rgbs.set(tileKey(address), rgb);
    };
    try {
        const pyramid = new Map<number, IRgbLevel>();
        for (let k = PYRAMID_MIN_K; k <= PYRAMID_MAX_K; k++) pyramid.set(k, await loadPyramidLevel(root, source, k));
        for (let lod = 0; lod <= globalMaxLOD; lod++) {
            const pending: Promise<void>[] = [];
            for (let face = 0; face < 6; face++)
                for (let y = 0; y < 2 ** lod; y++)
                    for (let x = 0; x < 2 ** lod; x++) {
                        const address = { face, lod, x, y };
                        pending.push(write(address, sampleTile(address, geometry, pyramid, PYRAMID_MAX_K)));
                    }
            await Promise.all(pending);
            console.log(`Level ${lod}: ${6 * 4 ** lod} tiles.`);
        }
        pyramid.clear();

        const image = await (await fromFile(storagePath(root, MORIC.file))).getImage(0);
        const taken = new Set(files.map((file) => tileKey(file.address)));
        for (const window of windows)
            for (const unit of windowTiles(window, globalMaxLOD + 1)) {
                const tiles = descendants(unit, deepest).filter((address) => !taken.has(tileKey(address)));
                if (tiles.length === 0) continue;
                const area = sourceWindow(tiles, geometry, PYRAMID_MAX_K, PYRAMID_MIN_K);
                const data = (await image.readRasters({
                    window: [area.col0, area.row0, area.col0 + area.cols, area.row0 + area.rows],
                    interleave: true,
                })) as unknown as Uint8Array;
                const base: IRgbLevel = { k: 0, ...area, data };
                const levels = new Map<number, IRgbLevel>([
                    [0, base],
                    ...reduceWindow(geometry, base, PYRAMID_MIN_K).map((level) => [level.k, level] as const),
                ]);
                const pending: Promise<void>[] = [];
                for (const address of tiles) {
                    pending.push(write(address, sampleTile(address, geometry, levels, PYRAMID_MIN_K)));
                    taken.add(tileKey(address));
                }
                await Promise.all(pending);
                console.log(
                    `${window.id}: tile ${tileKey(unit)} and ${tiles.length - 1} below it, from a ${area.cols} x ${area.rows} source window.`,
                );
            }

        const sharedBordersVerified = verifyGlobalBorders(files, false);
        const parentDifference: IMarsImageryManifest["parentDifference"] = [];
        for (let lod = 1; lod <= deepest; lod++) {
            const differences: number[] = [];
            for (const file of files) {
                if (file.address.lod !== lod) continue;
                const { face, x, y } = file.address;
                const parent = rgbs.get(tileKey({ face, lod: lod - 1, x: x >> 1, y: y >> 1 }));
                if (!parent) throw new Error(`${file.path} has no parent tile.`);
                const child = rgbs.get(tileKey(file.address))!;
                const offsetX = (x & 1) * (TILE_SIZE / 2),
                    offsetY = (y & 1) * (TILE_SIZE / 2);
                for (let row = 0; row <= TILE_SIZE; row += 2)
                    for (let column = 0; column <= TILE_SIZE; column += 2) {
                        const c = (row * (TILE_SIZE + 1) + column) * 3;
                        const p = ((offsetY + row / 2) * (TILE_SIZE + 1) + offsetX + column / 2) * 3;
                        differences.push(
                            Math.max(
                                Math.abs(child[c]! - parent[p]!),
                                Math.abs(child[c + 1]! - parent[p + 1]!),
                                Math.abs(child[c + 2]! - parent[p + 2]!),
                            ),
                        );
                    }
            }
            const sorted = Uint8Array.from(differences).sort();
            parentDifference.push({
                lod,
                median: percentile(sorted, 0.5),
                p95: percentile(sorted, 0.95),
                max: sorted[sorted.length - 1] ?? 0,
            });
        }
        rgbs.clear();

        files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const revision = sha256(Buffer.from(files.map((file) => `${file.path} ${file.sha256}`).join("\n"))).slice(
            0,
            20,
        );
        const subtrees = marsSubtrees(files, globalMaxLOD);
        await writeJson(resolve(work, "imagery.json"), {
            scheme: "spacexr-cube-equiangular/1",
            body: "Mars",
            frame: FRAME,
            referenceRadii: MARS_2000,
            content: "imagery",
            encoding: "webp",
            tileSize: TILE_SIZE,
            minLOD: 0,
            maxLOD: globalMaxLOD,
            subtrees,
            tiles: "./imagery/{face}/{z}/{x}/{y}.webp",
        });
        const manifest: IMarsImageryManifest = {
            schema: "mars-imagery/1",
            revision,
            status: "verified",
            maxLOD: globalMaxLOD,
            tileSize: TILE_SIZE,
            frame: FRAME,
            referenceRadii: MARS_2000,
            createdAt: new Date().toISOString(),
            sources: [
                {
                    id: MORIC.id,
                    url: source.url,
                    credit: source.credit,
                    rights: source.rights,
                    sha256: source.sha256,
                    resolutionMetres: geometry.pixelMetres,
                    minLOD: 0,
                    maxLOD: deepest,
                    windows: [...windows],
                    tiles: files.length,
                },
            ],
            parentDifference,
            files,
            sharedBordersVerified,
            bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        };
        await writeJson(resolve(work, "manifest.json"), manifest);

        const directory = `datasets/mars/imagery-${revision}`;
        const target = storagePath(root, directory);
        if (
            await stat(target).then(
                () => true,
                () => false,
            )
        )
            console.log(`Revision ${revision} already exists; nothing written.`);
        else {
            await mkdir(dirname(target), { recursive: true });
            await rename(work, target);
        }
        await writeJson(storagePath(root, "catalog/latest-imagery.json"), { directory, revision });
        console.log(
            `Mars imagery ${revision}: ${files.length} tiles, ${subtrees.length} subtrees, ` +
                `${sharedBordersVerified} shared borders verified, ${(manifest.bytes / 1e6).toFixed(1)} MB.`,
        );
        for (const { lod, median, p95, max } of parentDifference)
            console.log(`  level ${lod} against its parent: median ${median}, p95 ${p95}, max ${max}`);
        return revision;
    } finally {
        await rm(work, { recursive: true, force: true });
    }
}

import { randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import { CUBE_FACE_EDGES, cubeTileNeighbor } from "@spacexr/tiles/cube";
import { TileNeighbor, type ITileAddress } from "@spacexr/tiles/addressing";
import { borderHashes } from "../lunar/global-kernel";
import { renameDirectory, sha256, storagePath, writeJson } from "../lunar/storage";
import { GlobalMola, MOLA_MAX_LOD } from "./global-mola";
import type { IMarsImageryFile } from "./imagery/imagery-units";
import { MARS_REGIONS, REGIONAL_SCHEMA } from "./regional-refinement";

const TILE_SIZE = 256;
const SIDE = TILE_SIZE + 1;
export const MARS_2000: readonly [number, number, number] = [3396190, 3396190, 3376200];
export const FRAME = "IAU_MARS";
interface IRegionalTile {
    face: number;
    lod: number;
    x: number;
    y: number;
    minHeight: number;
    maxHeight: number;
    /** Part of the samples of the tile its own source covers. */
    coverage?: number;
    path: string;
    bytes: number;
    sha256: string;
}

interface IRegionalManifest {
    schema: string;
    region: string;
    sources: Array<{ id: string; url?: string; credit?: string; resolutionMetres: number; tiles: IRegionalTile[] }>;
}

/** One elevation tile of the global Mars tree. */
export interface IMarsGlobalFile {
    kind: "elevation";
    address: { face: number; lod: number; x: number; y: number };
    path: string;
    bytes: number;
    sha256: string;
    borders: string[];
    minHeight: number;
    maxHeight: number;
    source: string;
    /** Part of the samples of the tile its own source covers. */
    coverage: number;
    /**
     * Heights of a regional tile minus those of the deepest tile containing it, at the samples they share, in metres:
     * the median and the 95th percentile of the absolute difference.
     */
    parentDifference?: { median: number; p95: number };
}

/** Manifest of a global Mars revision, the counterpart of `lunar-global/1`. */
export interface IMarsGlobalManifest {
    schema: "mars-global/1";
    revision: string;
    status: "verified";
    maxLOD: number;
    tileSize: number;
    frame: string;
    referenceRadii: readonly [number, number, number];
    verticalDatum: string;
    createdAt: string;
    sources: Array<{
        id: string;
        /** Region of a regional source, absent for the global base. */
        region?: string;
        minLOD: number;
        maxLOD: number;
        resolutionMetres: number;
        url?: string;
        credit?: string;
        /** Content of the source, elevation when absent. */
        content?: "imagery";
        rights?: string;
        tiles: number;
    }>;
    files: IMarsGlobalFile[];
    /** Imagery of the revision, linked from the imagery revision `npm run mars -- imagery-moric` built last. */
    imagery?: { revision: string; maxLOD: number; files: IMarsImageryFile[] };
    sharedBordersVerified: number;
    bytes: number;
}

/** Decoded heights of a Terrarium tile, row by row. */
async function decodeHeights(file: string): Promise<Float32Array> {
    const { data } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const heights = new Float32Array(SIDE * SIDE);
    for (let index = 0; index < heights.length; index++)
        heights[index] = data[index * 4]! * 256 + data[index * 4 + 1]! + data[index * 4 + 2]! / 256 - 32768;
    return heights;
}

/**
 * Compares each tile below the global levels with the deepest tile containing it, at the samples they share: a source
 * that disagrees with the one below it shows here, as a tile filled from another source would have.
 */
async function compareWithParents(files: IMarsGlobalFile[], directory: string, globalMaxLOD: number): Promise<void> {
    const byKey = new Map(files.map((file) => [key(file.address), file]));
    const cache = new Map<string, Float32Array>();
    const heightsOf = async (file: IMarsGlobalFile): Promise<Float32Array> => {
        const cached = cache.get(file.path);
        if (cached) return cached;
        const heights = await decodeHeights(resolve(directory, file.path));
        cache.set(file.path, heights);
        if (cache.size > 64) cache.delete(cache.keys().next().value!);
        return heights;
    };
    const regional = files.filter((file) => file.address.lod > globalMaxLOD).sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const file of regional) {
        const { face, lod, x, y } = file.address;
        let parent: IMarsGlobalFile | undefined;
        for (let level = lod - 1; level >= 0 && !parent; level--) {
            const shift = lod - level;
            parent = byKey.get(key({ face, lod: level, x: Math.floor(x / 2 ** shift), y: Math.floor(y / 2 ** shift) }));
        }
        if (!parent) throw new Error(`${file.path} has no tile above it.`);
        const scale = 2 ** (lod - parent.address.lod);
        const span = TILE_SIZE / scale;
        const offsetX = (x % scale) * span;
        const offsetY = (y % scale) * span;
        const [own, below] = await Promise.all([heightsOf(file), heightsOf(parent)]);
        const differences: number[] = [];
        for (let row = 0; row <= span; row++)
            for (let col = 0; col <= span; col++)
                differences.push(
                    own[row * scale * SIDE + col * scale]! - below[(offsetY + row) * SIDE + offsetX + col]!,
                );
        const absolute = differences.map(Math.abs).sort((a, b) => a - b);
        const signed = [...differences].sort((a, b) => a - b);
        file.parentDifference = {
            median: signed[Math.floor(signed.length / 2)]!,
            p95: absolute[Math.floor(absolute.length * 0.95)]!,
        };
    }
    for (const id of new Set(regional.map((file) => file.source))) {
        const medians = regional
            .filter((file) => file.source === id)
            .map((file) => Math.abs(file.parentDifference!.median))
            .sort((a, b) => a - b);
        const worst = regional
            .filter((file) => file.source === id)
            .sort((a, b) => Math.abs(b.parentDifference!.median) - Math.abs(a.parentDifference!.median))[0]!;
        console.log(
            `${id}: |median| against the tile above, p50 ${medians[Math.floor(medians.length / 2)]!.toFixed(1)} m, ` +
                `max ${medians[medians.length - 1]!.toFixed(1)} m at ${key(worst.address)}.`,
        );
    }
}

const key = ({ face, lod, x, y }: { face: number; lod: number; x: number; y: number }): string =>
    `${face}/${lod}/${x}/${y}`;

/** Decoded Terrarium pixels of a tile: its height range and the fingerprints of its four borders. */
async function inspect(png: Buffer): Promise<{ minHeight: number; maxHeight: number; borders: string[] }> {
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== SIDE || info.height !== SIDE || info.channels !== 4)
        throw new Error(`Expected a ${SIDE} by ${SIDE} RGBA Terrarium tile`);
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    for (let index = 0; index < SIDE * SIDE; index++) {
        const height = data[index * 4]! * 256 + data[index * 4 + 1]! + data[index * 4 + 2]! / 256 - 32768;
        if (height < minHeight) minHeight = height;
        if (height > maxHeight) maxHeight = height;
    }
    // Borders compare heights only: the alpha channel of a Terrarium tile carries nothing.
    const rgb = new Uint8Array(SIDE * SIDE * 3);
    for (let index = 0; index < SIDE * SIDE; index++) rgb.set(data.subarray(index * 4, index * 4 + 3), index * 3);
    return { minHeight, maxHeight, borders: borderHashes(rgb, 3, SIDE) };
}

/**
 * Checks every border two tiles of the same level share, across cube faces too, where both exist. Tiles of different
 * levels never share a border sample for sample: a client joins them by reading the coarser data along the edge.
 */
function verifyBorders(files: readonly IMarsGlobalFile[]): number {
    const map = new Map(files.map((file) => [key(file.address), file]));
    const edges = [TileNeighbor.N, TileNeighbor.E, TileNeighbor.S, TileNeighbor.W] as const;
    let checked = 0;
    for (const file of files)
        for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
            const address = file.address;
            const neighbor = cubeTileNeighbor(address, edges[edgeIndex]!)!;
            const other = map.get(key({ ...neighbor.address, face: neighbor.address.face ?? 0 }));
            if (!other || key(address) >= key(other.address)) continue;
            const n = 2 ** address.lod;
            const boundary = [address.y === 0, address.x === n - 1, address.y === n - 1, address.x === 0][edgeIndex];
            const junction = boundary ? CUBE_FACE_EDGES[address.face]![edges[edgeIndex]!] : undefined;
            const otherEdge = junction ? edges.indexOf(junction.edge as (typeof edges)[number]) : (edgeIndex + 2) % 4;
            if (file.borders[edgeIndex * 2] !== other.borders[otherEdge * 2 + (junction?.reversed ? 1 : 0)])
                throw new Error(`Border mismatch: ${key(address)} and ${key(other.address)}`);
            checked++;
        }
    return checked;
}

/**
 * Deepest level down to which every descendant of each tile exists, for the tiles above the global levels. A client
 * reads a declared subtree as complete, so a subtree is declared only as deep as it is.
 */
function completeDepths(
    addresses: ReadonlySet<string>,
    files: readonly Pick<IMarsGlobalFile, "address">[],
): Map<string, number> {
    const depths = new Map<string, number>();
    const sorted = [...files].sort((a, b) => b.address.lod - a.address.lod);
    for (const { address } of sorted) {
        const { face, lod, x, y } = address;
        const children = [0, 1, 2, 3].map((index) =>
            key({ face, lod: lod + 1, x: 2 * x + (index & 1), y: 2 * y + (index >> 1) }),
        );
        depths.set(
            key(address),
            children.every((child) => addresses.has(child))
                ? Math.min(...children.map((child) => depths.get(child)!))
                : lod,
        );
    }
    return depths;
}

/** Subtrees of the descriptor: each tile whose complete depth its parent does not already declare. */
export function marsSubtrees(files: readonly Pick<IMarsGlobalFile, "address">[], globalMaxLOD: number) {
    const regional = files.filter((file) => file.address.lod > globalMaxLOD);
    const addresses = new Set(regional.map((file) => key(file.address)));
    const depths = completeDepths(addresses, regional);
    const subtrees: Array<{ face: number; lod: number; x: number; y: number; maxLOD: number }> = [];
    for (const { address } of regional) {
        const { face, lod, x, y } = address;
        const depth = depths.get(key(address))!;
        const parent = key({ face, lod: lod - 1, x: Math.floor(x / 2), y: Math.floor(y / 2) });
        const parentDepth = depths.get(parent);
        if (parentDepth === undefined || parentDepth < lod || depth > parentDepth)
            subtrees.push({ ...address, maxLOD: depth });
    }
    return subtrees.sort((a, b) => a.lod - b.lod || a.face - b.face || a.y - b.y || a.x - b.x);
}

async function place(source: string, target: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    // Same volume: a hard link keeps one copy of the regional tiles on disk.
    await link(source, target).catch(() => copyFile(source, target));
}

/** Manifest fields of an imagery revision that a global revision reads. */
interface IImageryRevision {
    schema: string;
    status: string;
    revision: string;
    maxLOD: number;
    sources: Array<{
        id: string;
        url: string;
        credit: string;
        rights: string;
        resolutionMetres: number;
        minLOD: number;
        maxLOD: number;
        tiles: number;
    }>;
    files: IMarsImageryFile[];
}

/**
 * Links the tiles of the imagery revision of `catalog/latest-imagery.json` into a global revision being built, each
 * checked against its manifest, with its `imagery.json` descriptor.
 *
 * @returns The imagery and its sources, or `undefined` when no imagery revision was built.
 */
async function linkImagery(
    root: string,
    work: string,
): Promise<
    { imagery: NonNullable<IMarsGlobalManifest["imagery"]>; sources: IMarsGlobalManifest["sources"] } | undefined
> {
    let pointer: { directory: string; revision: string };
    try {
        pointer = JSON.parse(
            await readFile(storagePath(root, "catalog/latest-imagery.json"), "utf8"),
        ) as typeof pointer;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    if (!/^[a-f0-9]{20}$/.test(pointer.revision) || pointer.directory !== `datasets/mars/imagery-${pointer.revision}`)
        throw new Error("The Mars latest-imagery pointer is invalid.");
    const manifest = JSON.parse(
        await readFile(storagePath(root, `${pointer.directory}/manifest.json`), "utf8"),
    ) as IImageryRevision;
    if (
        manifest.schema !== "mars-imagery/1" ||
        manifest.status !== "verified" ||
        manifest.revision !== pointer.revision
    )
        throw new Error(`The imagery revision ${pointer.revision} is not verified.`);
    let next = 0;
    const link = async (): Promise<void> => {
        while (next < manifest.files.length) {
            const file = manifest.files[next++]!;
            const source = storagePath(root, `${pointer.directory}/${file.path}`);
            const bytes = await readFile(source);
            if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
                throw new Error(`${file.path} differs from its imagery manifest entry.`);
            await place(source, resolve(work, file.path));
        }
    };
    await Promise.all(Array.from({ length: 16 }, link));
    await copyFile(storagePath(root, `${pointer.directory}/imagery.json`), resolve(work, "imagery.json"));
    console.log(
        `Imagery ${manifest.revision}: ${manifest.files.length} tiles, levels 0-${manifest.maxLOD} everywhere.`,
    );
    return {
        imagery: { revision: manifest.revision, maxLOD: manifest.maxLOD, files: manifest.files },
        sources: manifest.sources.map(({ id, url, credit, rights, resolutionMetres, minLOD, maxLOD, tiles }) => ({
            id,
            content: "imagery" as const,
            minLOD,
            maxLOD,
            resolutionMetres,
            url,
            credit,
            rights,
            tiles,
        })),
    };
}

/**
 * Builds an immutable global revision of Mars on the cube index: MOLA MEGR 16 ppd everywhere down to level 4, then the
 * sources of every region of {@link MARS_REGIONS} on their own levels, in one tree with a single URL template. Heights
 * are radial above the Mars 2000 ellipsoid in every source. Writes `datasets/mars/global-<revision>/` with its
 * `elevation.json` descriptor and manifest, then `catalog/latest-global.json`.
 *
 * @param root - Mars data directory holding the MOLA source and the regional refinements.
 */
export async function buildGlobalMars(root: string): Promise<string> {
    const mola = new GlobalMola(root);
    if (!(await mola.available())) throw new Error("The MOLA MEGR 16 ppd raster is missing under sources/mola/meg016.");
    const regions = await Promise.all(
        MARS_REGIONS.map(async (region) => {
            const manifest = JSON.parse(
                await readFile(storagePath(root, `datasets/mars/${region.id}/manifest.json`), "utf8"),
            ) as IRegionalManifest;
            if (manifest.schema !== REGIONAL_SCHEMA || manifest.region !== region.id)
                throw new Error(`Rebuild the ${region.id} refinement: npm run mars -- refine --region ${region.id}`);
            return { region, manifest };
        }),
    );

    const work = storagePath(root, `work/mars-global-${randomUUID()}`);
    const files: IMarsGlobalFile[] = [];
    const sources: IMarsGlobalManifest["sources"] = [];
    let built = false;
    try {
        let molaTiles = 0;
        for (let face = 0; face < 6; face++)
            for (let lod = 0; lod <= MOLA_MAX_LOD; lod++)
                for (let y = 0; y < 2 ** lod; y++)
                    for (let x = 0; x < 2 ** lod; x++) {
                        const address = { face, lod, x, y };
                        const png = await mola.tile(address as ITileAddress);
                        const path = `elevation/${key(address)}.png`;
                        const target = resolve(work, path);
                        await mkdir(dirname(target), { recursive: true });
                        await writeFile(target, png);
                        files.push({
                            kind: "elevation",
                            address,
                            path,
                            bytes: png.length,
                            sha256: sha256(png),
                            source: "mola-megr-16ppd",
                            coverage: 1,
                            ...(await inspect(png)),
                        });
                        molaTiles++;
                    }
        sources.push({
            id: "mola-megr-16ppd",
            minLOD: 0,
            maxLOD: MOLA_MAX_LOD,
            resolutionMetres: 3705,
            url: "https://pds-geosciences.wustl.edu/missions/mgs/megdr.html",
            tiles: molaTiles,
        });
        console.log(`MOLA: ${molaTiles} tiles, levels 0-${MOLA_MAX_LOD}.`);

        const taken = new Set(files.map((file) => key(file.address)));
        for (const { region, manifest } of regions)
            for (const { id } of region.sources) {
                const source = manifest.sources.find((candidate) => candidate.id === id);
                if (!source) throw new Error(`The ${region.id} manifest has no ${id} source.`);
                for (const tile of source.tiles) {
                    const address = { face: tile.face, lod: tile.lod, x: tile.x, y: tile.y };
                    if (address.lod <= MOLA_MAX_LOD)
                        throw new Error(`${id} tile ${key(address)} overlaps the global levels.`);
                    if (taken.has(key(address)))
                        throw new Error(`${id} tile ${key(address)} is already taken by another source.`);
                    const file = storagePath(root, tile.path);
                    const png = await readFile(file);
                    if (png.length !== tile.bytes || sha256(png) !== tile.sha256)
                        throw new Error(`${tile.path} differs from its ${region.id} manifest entry.`);
                    // A tile with none of its own data would hide the source below it.
                    if (tile.coverage === undefined)
                        throw new Error(`${tile.path} has no coverage: rebuild the ${region.id} refinement.`);
                    if (tile.coverage === 0) throw new Error(`${tile.path} holds no sample of ${id}.`);
                    const path = `elevation/${key(address)}.png`;
                    await place(file, resolve(work, path));
                    files.push({
                        kind: "elevation",
                        address,
                        path,
                        bytes: png.length,
                        sha256: tile.sha256,
                        source: id,
                        coverage: tile.coverage,
                        ...(await inspect(png)),
                    });
                    taken.add(key(address));
                }
                const levels = source.tiles.map((tile) => tile.lod);
                sources.push({
                    id,
                    region: region.id,
                    minLOD: Math.min(...levels),
                    maxLOD: Math.max(...levels),
                    resolutionMetres: source.resolutionMetres,
                    ...(source.url ? { url: source.url } : {}),
                    ...(source.credit ? { credit: source.credit } : {}),
                    tiles: source.tiles.length,
                });
                console.log(
                    `${region.id} ${id}: ${source.tiles.length} tiles, levels ${Math.min(...levels)}-${Math.max(...levels)}.`,
                );
            }

        const imagery = await linkImagery(root, work);
        if (imagery) sources.push(...imagery.sources);
        const sharedBordersVerified = verifyBorders(files);
        await compareWithParents(files, work, MOLA_MAX_LOD);
        files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const listed = [...files, ...(imagery?.imagery.files ?? [])];
        const revision = sha256(Buffer.from(listed.map((file) => `${file.path} ${file.sha256}`).join("\n"))).slice(
            0,
            20,
        );
        const subtrees = marsSubtrees(files, MOLA_MAX_LOD);
        await writeJson(resolve(work, "elevation.json"), {
            scheme: "spacexr-cube-equiangular/1",
            body: "Mars",
            frame: FRAME,
            referenceRadii: MARS_2000,
            content: "elevation",
            encoding: "terrarium",
            tileSize: TILE_SIZE,
            minLOD: 0,
            maxLOD: MOLA_MAX_LOD,
            subtrees,
            tiles: "./elevation/{face}/{z}/{x}/{y}.png",
        });
        const manifest: IMarsGlobalManifest = {
            schema: "mars-global/1",
            revision,
            status: "verified",
            maxLOD: MOLA_MAX_LOD,
            tileSize: TILE_SIZE,
            frame: FRAME,
            referenceRadii: MARS_2000,
            verticalDatum:
                "radial height above the Mars 2000 ellipsoid; each regional source blends into the source below it at the limit of its data, down to MOLA MEGR 16 ppd",
            createdAt: new Date().toISOString(),
            sources,
            files,
            ...(imagery ? { imagery: imagery.imagery } : {}),
            sharedBordersVerified,
            bytes: listed.reduce((sum, file) => sum + file.bytes, 0),
        };
        await writeJson(resolve(work, "manifest.json"), manifest);
        built = true;

        const directory = `datasets/mars/global-${revision}`;
        const target = storagePath(root, directory);
        if (
            await stat(target).then(
                () => true,
                () => false,
            )
        ) {
            console.log(`Revision ${revision} already exists; nothing written.`);
            await rm(work, { recursive: true, force: true });
        } else {
            await mkdir(dirname(target), { recursive: true });
            await renameDirectory(work, target);
        }
        await writeJson(storagePath(root, "catalog/latest-global.json"), { directory, revision });
        console.log(
            `Global Mars ${revision}: ${files.length} tiles, ${subtrees.length} subtrees, ` +
                `${sharedBordersVerified} shared borders verified, ${(manifest.bytes / 1e6).toFixed(1)} MB.`,
        );
        return revision;
    } catch (error) {
        // Tiles already built are kept: a failed rename leaves them to be moved by hand.
        if (built) console.error(`The finished revision stays in ${work}.`);
        else await rm(work, { recursive: true, force: true });
        throw error;
    }
}

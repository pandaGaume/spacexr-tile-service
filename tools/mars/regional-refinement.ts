import { createHash } from "node:crypto";
import { readFile, readdir, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { fromFile } from "geotiff";
import { createHeightGrid, encodeTerrariumGrid } from "@spacexr/dem";
import { cubeFaceCoordinates, cubeFaceDirection, type CubeFace } from "@spacexr/tiles/cube";
import { loadMolaRadius16, MOLA_MAX_LOD } from "./global-mola";

const TILE_SIZE = 256;
const DEFAULT_ROOT = "F:/MarsData";
const MOLA_4_PPD = "sources/mola/meg004";
/** Radius of the Mars sphere the regional products and MOLA are mapped on, in metres. */
const MARS_SPHERE = 3396190;
const ELLIPSOID_A = 3396190;
const ELLIPSOID_C = 3376200;
/** Distance between two samples of MOLA MEGR 16 ppd along the equator of the reference sphere, in metres. */
const MOLA_16_SPACING = (2 * Math.PI * MARS_SPHERE) / (360 * 16);
/** Distance between two samples of a level 0 tile along the sphere: a face spans a quarter turn. */
const LEVEL_0_SPACING = ((Math.PI / 2) * MARS_SPHERE) / TILE_SIZE;

/** A regional DEM, its place in the data root and its provenance. */
export interface IRegionalSource {
    id: string;
    /** GeoTIFF relative to the Mars data root, heights in metres above the MOLA areoid. */
    file: string;
    url: string;
    credit: string;
}

/** A region refined above the global MOLA base, as a cascade of sources from the coarsest to the finest. */
export interface IRegion {
    id: string;
    name: string;
    sources: readonly IRegionalSource[];
}

export const MARS_REGIONS: readonly IRegion[] = [
    {
        id: "jezero",
        name: "Jezero crater",
        sources: [
            {
                id: "ctx-20m",
                file: "sources/jezero/ctx/M20_JezeroCrater_CTXDEM_20m.tif",
                url: "https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.tif",
                credit: "NASA/JPL/MSSS/USGS, Mars 2020 CTX science investigation DEM",
            },
            {
                id: "hirise-1m",
                file: "sources/jezero/hirise/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif",
                url: "https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif",
                credit: "NASA/JPL/University of Arizona/USGS, Mars 2020 TRN HiRISE DTM",
            },
        ],
    },
    {
        id: "utopia",
        name: "Utopia Planitia, Zhurong landing region",
        sources: [
            {
                id: "hiric-3.5m",
                file: "sources/utopia/hiric/HX1_GRAS_HIRIC_DEM_3.5_0000_244453N1101905E_A.tif",
                url: "https://clpds.bao.ac.cn/web/enmanager/mars1",
                credit: "Tianwen-1 HiRIC, China's Lunar and Planetary Data System (CLPDS), NAOC/GRAS",
            },
        ],
    },
];

interface IRaster {
    width: number;
    height: number;
    originX: number;
    originY: number;
    pixelX: number;
    pixelY: number;
    noData: number;
    standardParallel: number;
    centralMeridian: number;
    values: Float32Array;
}

interface IBounds {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
}

/**
 * A regional DEM in the cascade of sources: where it has data, it gives the heights; towards the limit of its data it
 * blends into the source below it over one sample of that source, which cannot hold anything narrower.
 */
interface ISource {
    raster: IRaster;
    /** Distance in pixels from each valid pixel to the nearest pixel without data or to the edge, at most `blendPixels`. */
    inside: Float32Array;
    blendPixels: number;
}

function sha256(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

function valid(raster: IRaster, value: number): boolean {
    return Number.isFinite(value) && value !== raster.noData;
}

/**
 * Deepest cube level whose samples are not finer than those of a raster: no level announces detail its source does
 * not hold.
 */
export function deepestLevel(pixelMetres: number): number {
    return Math.floor(Math.log2(LEVEL_0_SPACING / pixelMetres));
}

/**
 * Levels of each source of a region, coarsest first: the first starts right below the global MOLA levels, each next
 * one right below the previous, and each ends at its {@link deepestLevel}.
 */
export function regionLevels(pixelMetres: readonly number[]): Array<{ minLOD: number; maxLOD: number }> {
    const levels: Array<{ minLOD: number; maxLOD: number }> = [];
    let minLOD = MOLA_MAX_LOD + 1;
    for (const pixel of pixelMetres) {
        const maxLOD = deepestLevel(pixel);
        if (maxLOD < minLOD) throw new Error(`A source of ${pixel} m adds no level below level ${minLOD - 1}.`);
        levels.push({ minLOD, maxLOD });
        minLOD = maxLOD + 1;
    }
    return levels;
}

/**
 * Chamfer distance, in pixels, from each pixel with data to the nearest pixel without data, the area outside the raster
 * counting as without data. Only distances up to `limit` matter, the width of a blend.
 */
function insideDistance(raster: IRaster, limit: number): Float32Array {
    const { width, height, values } = raster;
    const distance = new Float32Array(width * height);
    for (let index = 0; index < distance.length; index++) distance[index] = valid(raster, values[index]!) ? limit : 0;
    const diagonal = Math.SQRT2;
    const at = (x: number, y: number): number =>
        x < 0 || y < 0 || x >= width || y >= height ? 0 : distance[y * width + x]!;
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (distance[index] === 0) continue;
            distance[index] = Math.min(
                distance[index]!,
                at(x - 1, y) + 1,
                at(x, y - 1) + 1,
                at(x - 1, y - 1) + diagonal,
                at(x + 1, y - 1) + diagonal,
            );
        }
    for (let y = height - 1; y >= 0; y--)
        for (let x = width - 1; x >= 0; x--) {
            const index = y * width + x;
            if (distance[index] === 0) continue;
            distance[index] = Math.min(
                distance[index]!,
                at(x + 1, y) + 1,
                at(x, y + 1) + 1,
                at(x + 1, y + 1) + diagonal,
                at(x - 1, y + 1) + diagonal,
            );
        }
    return distance;
}

function source(raster: IRaster, spacingBelow: number): ISource {
    const blendPixels = spacingBelow / raster.pixelX;
    return { raster, inside: insideDistance(raster, blendPixels), blendPixels };
}

async function loadGeoTiff(file: string): Promise<IRaster> {
    const tiff = await fromFile(file);
    try {
        const image = await tiff.getImage();
        const origin = image.getOrigin();
        const resolution = image.getResolution();
        const values = (await image.readRasters({ interleave: true })) as Float32Array;
        if (!origin || !resolution || image.getSamplesPerPixel() !== 1) throw new Error(`Unsupported GeoTIFF: ${file}`);
        const keys = image.getGeoKeys();
        return {
            width: image.getWidth(),
            height: image.getHeight(),
            originX: origin[0]!,
            originY: origin[1]!,
            pixelX: resolution[0]!,
            pixelY: Math.abs(resolution[1]!),
            noData: Number(image.getGDALNoData()),
            standardParallel: Number(keys?.ProjStdParallel1GeoKey ?? 0),
            centralMeridian: Number(keys?.ProjNatOriginLongGeoKey ?? keys?.ProjCenterLongGeoKey ?? 0),
            values,
        };
    } finally {
        await tiff.close();
    }
}

/** Bilinear height of a raster where its samples have data, `NaN` elsewhere. */
function sampleRaster(raster: IRaster, x: number, y: number): number {
    const px = (x - raster.originX) / raster.pixelX - 0.5;
    const py = (raster.originY - y) / raster.pixelY - 0.5;
    const x0 = Math.floor(px),
        y0 = Math.floor(py),
        fx = px - x0,
        fy = py - y0;
    let sum = 0,
        weight = 0;
    for (const [dx, dy, w] of [
        [0, 0, (1 - fx) * (1 - fy)],
        [1, 0, fx * (1 - fy)],
        [0, 1, (1 - fx) * fy],
        [1, 1, fx * fy],
    ] as const) {
        const x = x0 + dx,
            y = y0 + dy;
        if (!w || x < 0 || y < 0 || x >= raster.width || y >= raster.height) continue;
        const value = raster.values[y * raster.width + x]!;
        if (!valid(raster, value)) continue;
        sum += value * w;
        weight += w;
    }
    return weight ? sum / weight : Number.NaN;
}

function smoothstep(value: number): number {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
}

/** Projected coordinates of a planetocentric position in an equirectangular raster on the Mars sphere. */
function sourceXY(latitude: number, longitude: number, raster: IRaster): [number, number] {
    let delta = longitude - raster.centralMeridian;
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
    const p = (raster.standardParallel * Math.PI) / 180;
    return [((delta * Math.PI) / 180) * MARS_SPHERE * Math.cos(p), ((latitude * Math.PI) / 180) * MARS_SPHERE];
}

function sourceBounds(raster: IRaster): IBounds {
    const xs = [raster.originX, raster.originX + raster.width * raster.pixelX];
    const ys = [raster.originY, raster.originY - raster.height * raster.pixelY];
    const parallel = (raster.standardParallel * Math.PI) / 180;
    const lats = ys.map((y) => ((y / MARS_SPHERE) * 180) / Math.PI);
    const lons = xs.map((x) => raster.centralMeridian + ((x / (MARS_SPHERE * Math.cos(parallel))) * 180) / Math.PI);
    return {
        minLat: Math.min(...lats),
        maxLat: Math.max(...lats),
        minLon: Math.min(...lons),
        maxLon: Math.max(...lons),
    };
}

function addresses(
    region: string,
    bounds: IBounds,
    lod: number,
): Array<{ face: CubeFace; lod: number; x: number; y: number }> {
    const positions = [
        [bounds.minLat, bounds.minLon],
        [bounds.minLat, bounds.maxLon],
        [bounds.maxLat, bounds.minLon],
        [bounds.maxLat, bounds.maxLon],
    ].map(([lat, lon]) => {
        const p = (lat! * Math.PI) / 180,
            l = (lon! * Math.PI) / 180;
        return cubeFaceCoordinates({ x: Math.cos(p) * Math.cos(l), y: Math.cos(p) * Math.sin(l), z: Math.sin(p) });
    });
    const face = positions[0]!.face;
    if (positions.some((p) => p.face !== face)) throw new Error(`The ${region} extent spans several cube faces.`);
    const n = 2 ** lod;
    const minX = Math.max(0, Math.floor(Math.min(...positions.map((p) => p.u)) * n) - 1);
    const maxX = Math.min(n - 1, Math.floor(Math.max(...positions.map((p) => p.u)) * n) + 1);
    const minY = Math.max(0, Math.floor(Math.min(...positions.map((p) => p.v)) * n) - 1);
    const maxY = Math.min(n - 1, Math.floor(Math.max(...positions.map((p) => p.v)) * n) + 1);
    const result = [];
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) result.push({ face, lod, x, y });
    return result;
}

interface IMolaGrid {
    values: Int16Array;
    radius: boolean;
}

/** Load one native MOLA 4 ppd global grid from its PDS big-endian signed samples, for the areoid. */
async function loadMolaGrid(root: string, kind: "megr" | "megt"): Promise<IMolaGrid> {
    const file = resolve(root, MOLA_4_PPD, `${kind}90n000cb.img`);
    const bytes = await readFile(file);
    if (bytes.length !== 720 * 1440 * 2) throw new Error(`Invalid MOLA raster ${file}`);
    const values = new Int16Array(bytes.length / 2);
    for (let i = 0; i < values.length; i++) values[i] = bytes.readInt16BE(i * 2);
    return { values, radius: kind === "megr" };
}

/** Bilinearly sample a global, pixel-centred MOLA grid at planetocentric coordinates. */
function sampleMola(grid: IMolaGrid, latitude: number, longitude: number): number {
    const normalizedLongitude = ((longitude % 360) + 360) % 360;
    const x = normalizedLongitude * 4 - 0.5;
    const y = (90 - latitude) * 4 - 0.5;
    const x0 = Math.floor(x),
        y0 = Math.floor(y),
        fx = x - x0,
        fy = y - y0;
    let total = 0;
    for (const [dx, dy, w] of [
        [0, 0, (1 - fx) * (1 - fy)],
        [1, 0, fx * (1 - fy)],
        [0, 1, (1 - fx) * fy],
        [1, 1, fx * fy],
    ] as const) {
        const col = x0 + dx,
            row = y0 + dy;
        const wrappedColumn = (col + 1440) % 1440;
        if (row < 0 || row >= 720) continue;
        total += grid.values[row * 1440 + wrappedColumn]! * w;
    }
    return total + (grid.radius ? 3396000 : 0);
}

/** What a regional tile reads: its sources, finest first, the areoid they are measured from and the global base below. */
interface ICascade {
    sources: readonly ISource[];
    /** Radius of the areoid, from the smooth MOLA 4 ppd products: MEGR minus MEGT. */
    areoid: (latitude: number, longitude: number) => number;
    /** Radius of the global base, MOLA MEGR 16 ppd, the same as the global tiles. */
    base: (latitude: number, longitude: number) => number;
}

/** Weight of a source at a point: 1 inside its data, falling to 0 at its limit over one sample of the source below. */
function weightAt(source: ISource, x: number, y: number): number {
    const { raster } = source;
    const px = Math.floor((x - raster.originX) / raster.pixelX);
    const py = Math.floor((raster.originY - y) / raster.pixelY);
    if (px < 0 || py < 0 || px >= raster.width || py >= raster.height) return 0;
    return smoothstep(source.inside[py * raster.width + px]! / source.blendPixels);
}

/** Radius at a direction from the sources of a cascade, starting at `index`, and the weight of that source. */
function cascadeRadius(
    cascade: ICascade,
    index: number,
    latitude: number,
    longitude: number,
): { radius: number; weight: number } {
    const below = (): number =>
        index + 1 < cascade.sources.length
            ? cascadeRadius(cascade, index + 1, latitude, longitude).radius
            : cascade.base(latitude, longitude);
    const source = cascade.sources[index]!;
    const [x, y] = sourceXY(latitude, longitude, source.raster);
    const height = sampleRaster(source.raster, x, y);
    const weight = Number.isFinite(height) ? weightAt(source, x, y) : 0;
    if (weight === 0) return { radius: below(), weight };
    const own = cascade.areoid(latitude, longitude) + height;
    return { radius: weight === 1 ? own : own * weight + below() * (1 - weight), weight };
}

/**
 * Reproject the first source of a cascade onto the cube tiles of its footprint. Heights are moved from the MOLA areoid
 * onto the Mars 2000 ellipsoid along each planetocentric direction. Where the source has no data, the tile reads the
 * sources below it, down to the global MOLA 16 ppd base; a tile holding no sample of its source is not written, and a
 * client reads its place from the tiles below.
 */
async function buildTiles(
    root: string,
    directory: string,
    cascade: ICascade,
    region: string,
    bounds: IBounds,
    minLOD: number,
    maxLOD: number,
): Promise<object[]> {
    const files: object[] = [];
    const invA = 1 / (ELLIPSOID_A * ELLIPSOID_A),
        invC = 1 / (ELLIPSOID_C * ELLIPSOID_C);
    const samples = (TILE_SIZE + 1) ** 2;
    for (let lod = minLOD; lod <= maxLOD; lod++)
        for (const tile of addresses(region, bounds, lod)) {
            const heights = new Float32Array(samples);
            let min = Infinity,
                max = -Infinity,
                covered = 0;
            for (let row = 0; row <= TILE_SIZE; row++)
                for (let col = 0; col <= TILE_SIZE; col++) {
                    const dir = cubeFaceDirection(
                        tile.face,
                        (tile.x + col / TILE_SIZE) / 2 ** lod,
                        (tile.y + row / TILE_SIZE) / 2 ** lod,
                    );
                    const lat = (Math.atan2(dir.z, Math.hypot(dir.x, dir.y)) * 180) / Math.PI;
                    let lon = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
                    if (lon < 0) lon += 360;
                    const { radius, weight } = cascadeRadius(cascade, 0, lat, lon);
                    if (weight > 0) covered++;
                    const ellipsoidRadius =
                        1 / Math.sqrt((dir.x * dir.x + dir.y * dir.y) * invA + dir.z * dir.z * invC);
                    const height = radius - ellipsoidRadius;
                    heights[row * (TILE_SIZE + 1) + col] = height;
                    min = Math.min(min, height);
                    max = Math.max(max, height);
                }
            if (covered === 0) continue;
            const image = encodeTerrariumGrid(createHeightGrid(TILE_SIZE + 1, TILE_SIZE + 1, heights));
            const bytes = await sharp(image.data, { raw: { width: TILE_SIZE + 1, height: TILE_SIZE + 1, channels: 4 } })
                .png({ compressionLevel: 4 })
                .toBuffer();
            const path = `${directory}/elevation/${tile.face}/${lod}/${tile.x}/${tile.y}.png`;
            const full = resolve(root, path);
            await mkdir(dirname(full), { recursive: true });
            await writeFile(full, bytes);
            files.push({
                ...tile,
                minHeight: min,
                maxHeight: max,
                coverage: covered / samples,
                path,
                bytes: bytes.length,
                sha256: sha256(bytes),
            });
        }
    return files;
}

/** Removes the tiles of a source that a new build no longer writes. */
async function removeStale(root: string, directory: string, tiles: readonly object[]): Promise<number> {
    const kept = new Set(tiles.map((tile) => (tile as { path: string }).path));
    let removed = 0;
    const walk = async (folder: string): Promise<void> => {
        for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
            const path = resolve(folder, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (!kept.has(relative(root, path).split(sep).join("/"))) {
                await unlink(path);
                removed++;
            }
        }
    };
    await walk(resolve(root, directory));
    return removed;
}

async function cascadeBase(root: string): Promise<Pick<ICascade, "areoid" | "base">> {
    const [megr, megt, base] = await Promise.all([
        loadMolaGrid(root, "megr"),
        loadMolaGrid(root, "megt"),
        loadMolaRadius16(root),
    ]);
    return { areoid: (lat, lon) => sampleMola(megr, lat, lon) - sampleMola(megt, lat, lon), base };
}

/** Schema of the manifest of a regional refinement, `datasets/mars/<region>/manifest.json`. */
export const REGIONAL_SCHEMA = "mars-regional-refinement/1";

const regionDirectory = (region: string): string => `datasets/mars/${region}`;

async function readRegionalManifest(
    root: string,
    region: string,
): Promise<{ sources: Array<Record<string, unknown>> }> {
    const text = await readFile(resolve(root, regionDirectory(region), "manifest.json"), "utf8").catch(() => undefined);
    return text ? (JSON.parse(text) as { sources: Array<Record<string, unknown>> }) : { sources: [] };
}

/**
 * Build the elevation refinement of a region as Terrarium-encoded cube tiles. Each source is a cascade: it gives the
 * heights where it has data, the coarser sources of the region below it, then the global MOLA MEGR 16 ppd base, each
 * blending into the next one over a sample of it. The levels of each source follow {@link regionLevels}. The manifest
 * records the exact tile inventory and the part of each tile its source covers.
 *
 * @param root - Mars data directory containing imported source rasters.
 * @param region - The region to build, one of {@link MARS_REGIONS}.
 */
export async function buildRegionalRefinement(root: string, region: IRegion): Promise<void> {
    const base = await cascadeBase(root);
    const built: ISource[] = [];
    const entries: Array<Record<string, unknown>> = [];
    let previousSpacing = MOLA_16_SPACING;
    for (const [index, definition] of region.sources.entries()) {
        const file = resolve(root, definition.file);
        const raster = await loadGeoTiff(file);
        const levels = regionLevels([...built.map((entry) => entry.raster.pixelY).reverse(), raster.pixelY])[index]!;
        built.unshift(source(raster, previousSpacing));
        const directory = `${regionDirectory(region.id)}/${definition.id}`;
        const tiles = await buildTiles(
            root,
            directory,
            { ...base, sources: built },
            region.id,
            sourceBounds(raster),
            levels.minLOD,
            levels.maxLOD,
        );
        const removed = await removeStale(root, directory, tiles);
        console.log(
            `${region.id} ${definition.id}: ${tiles.length} tiles, levels ${levels.minLOD}-${levels.maxLOD}, ${removed} stale removed.`,
        );
        entries.push({
            id: definition.id,
            resolutionMetres: raster.pixelY,
            ...levels,
            url: definition.url,
            credit: definition.credit,
            file,
            bytes: (await stat(file)).size,
            ...(index > 0 ? { parentSource: region.sources[index - 1]!.id } : {}),
            tiles,
        });
        previousSpacing = raster.pixelX;
    }
    const manifestPath = resolve(root, regionDirectory(region.id), "manifest.json");
    const previous = await readRegionalManifest(root, region.id);
    const ids = new Set(region.sources.map((definition) => definition.id));
    const manifest = {
        schema: REGIONAL_SCHEMA,
        body: "Mars",
        region: region.id,
        name: region.name,
        projection: "planetocentric equirectangular",
        verticalDatum:
            "radial height above the Mars 2000 ellipsoid; regional heights from the MOLA areoid of the smoothed 4 ppd MEGR and MEGT products; where a source has no data, the source below it, down to MOLA MEGR 16 ppd",
        tileSize: TILE_SIZE,
        tileUrlTemplate: `/mars/${regionDirectory(region.id)}/{source}/elevation/{face}/{lod}/{x}/{y}.png`,
        // Other sources, such as the experimental CTX correction of Jezero, keep their entries until rebuilt.
        sources: [...entries, ...previous.sources.filter((entry) => !ids.has(entry.id as string))],
        geoidSources: [
            {
                id: "MOLA MEGR 4 ppd",
                file: resolve(root, MOLA_4_PPD, "megr90n000cb.img"),
                url: "https://pds-geosciences.wustl.edu/missions/mgs/megdr.html",
            },
            {
                id: "MOLA MEGT 4 ppd",
                file: resolve(root, MOLA_4_PPD, "megt90n000cb.img"),
                url: "https://pds-geosciences.wustl.edu/missions/mgs/megdr.html",
            },
        ],
        baseSource: {
            id: "MOLA MEGR 16 ppd",
            file: resolve(root, "sources/mola/meg016/megr90n000eb.img"),
            url: "https://pds-geosciences.wustl.edu/missions/mgs/megdr.html",
        },
        generatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`${region.name}: manifest written to ${manifestPath}`);
}

/**
 * Build an experimental CTX correction of Jezero as a separate tile source, on the levels of `ctx-20m`. The source must
 * use the same grid and georeferencing as the original CTX DEM. The original tiles remain available for direct visual
 * comparison.
 *
 * @param root - Mars data directory containing the original CTX tiles and manifest.
 */
export async function buildJezeroCtxCorrection(root = DEFAULT_ROOT): Promise<void> {
    const jezero = MARS_REGIONS.find((region) => region.id === "jezero")!;
    const originalPath = resolve(root, jezero.sources[0]!.file);
    const correctedPath = resolve(root, "sources/jezero/ctx/Jezero_CTXDEM_20m_correction_experimentale.tif");
    const [original, corrected, base] = await Promise.all([
        loadGeoTiff(originalPath),
        loadGeoTiff(correctedPath),
        cascadeBase(root),
    ]);
    const sameGrid =
        original.width === corrected.width &&
        original.height === corrected.height &&
        original.originX === corrected.originX &&
        original.originY === corrected.originY &&
        original.pixelX === corrected.pixelX &&
        original.pixelY === corrected.pixelY &&
        original.standardParallel === corrected.standardParallel &&
        original.centralMeridian === corrected.centralMeridian;
    if (!sameGrid)
        throw new Error(
            "Corrected CTX GeoTIFF grid differs from the original; refusing to generate misregistered tiles.",
        );
    const { minLOD, maxLOD } = regionLevels([corrected.pixelY])[0]!;
    const directory = `${regionDirectory("jezero")}/ctx-20m-corrected`;
    const tiles = await buildTiles(
        root,
        directory,
        { ...base, sources: [source(corrected, MOLA_16_SPACING)] },
        "jezero",
        sourceBounds(corrected),
        minLOD,
        maxLOD,
    );
    const removed = await removeStale(root, directory, tiles);
    const manifestPath = resolve(root, regionDirectory("jezero"), "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        schema: string;
        sources: Array<Record<string, unknown>>;
        generatedAt?: string;
    };
    if (manifest.schema !== REGIONAL_SCHEMA)
        throw new Error("Build the Jezero refinement first: npm run mars -- refine --region jezero");
    manifest.sources = manifest.sources.filter((entry) => entry.id !== "ctx-20m-corrected");
    manifest.sources.push({
        id: "ctx-20m-corrected",
        resolutionMetres: corrected.pixelY,
        minLOD,
        maxLOD,
        file: correctedPath,
        bytes: (await stat(correctedPath)).size,
        parentSource: "ctx-20m",
        quality: "experimental, not scientifically validated",
        tiles,
    });
    manifest.generatedAt = new Date().toISOString();
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(
        `Jezero corrected CTX: ${tiles.length} experimental DEM tiles, ${removed} stale removed, written to ${manifestPath}`,
    );
}

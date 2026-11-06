import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { fromArrayBuffer } from "geotiff";
import { createHeightGrid, encodeTerrariumGrid } from "@spacexr/dem";
import { encodeFloat32Dem, validateManifest } from "@spacexr-service/tile2d-core";
import type { ITile2DManifest } from "@spacexr-service/shared";
import { digest, saveObject, uploadPublication, type IPublicationObject } from "./common";
import { elevationGrid, validateElevationRaster } from "./lunar-dem";

const sourcePage = "https://svs.gsfc.nasa.gov/4720/";
const sourceBase = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/";
// Pinned input bytes make a changed upstream product an explicit review, not a silent update.
const sources = [
    { file: "lroc_color_2k.jpg", hash: "f7130a1822681fa7512d7dcfd40db8c10b9ba4f06777910348698260ed7a2170" },
    { file: "ldem_4.tif", hash: "330afa2556a86fd05ac6ba2f912f246600fdade35de2a0d90593d50d07b01b65" },
];
/** Download a bounded, known NASA product and verify its exact bytes. */
async function sourceFile(source: (typeof sources)[number]): Promise<Buffer> {
    const directory = resolve(".local/nasa-sources");
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, source.file);
    let bytes: Buffer;
    try {
        bytes = await readFile(path);
    } catch {
        const response = await fetch(sourceBase + source.file, { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error(`NASA download failed: HTTP ${response.status}`);
        const chunks: Uint8Array[] = [];
        let length = 0;
        if (!response.body) throw new Error("Missing NASA response body");
        const reader = response.body.getReader();
        try {
            let chunk = await reader.read();
            while (!chunk.done) {
                const value = chunk.value;
                length += value.byteLength;
                if (length > 8 * 1024 * 1024) {
                    await reader.cancel();
                    throw new Error("NASA source exceeds size limit");
                }
                chunks.push(value);
                chunk = await reader.read();
            }
        } finally {
            reader.releaseLock();
        }
        bytes = Buffer.concat(chunks);
    }
    if (digest(bytes) !== source.hash) throw new Error(`NASA source checksum changed: ${source.file}`);
    await writeFile(path, bytes);
    return bytes;
}

/** Build one low-resolution NASA lunar publication; optional upload uses Wrangler's OAuth session. */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const bucket = args[0] === "--upload" ? args[1] : undefined;
    if (args.length && (!bucket || args.length !== 2 || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)))
        throw new Error("Usage: tsx tools/r2/nasa-moon.ts [--upload BUCKET]");
    const [colour, dem] = await Promise.all(sources.map(sourceFile));
    const metadata = await sharp(colour).metadata();
    if (metadata.width !== 2048 || metadata.height !== 1024)
        throw new Error("Unexpected NASA colour raster dimensions");
    const tiff = await fromArrayBuffer(Uint8Array.from(dem).buffer);
    const image = await tiff.getImage();
    if (image.getWidth() !== 1440 || image.getHeight() !== 720 || image.getSamplesPerPixel() !== 1)
        throw new Error("Unexpected NASA DEM dimensions");
    const values = await image.readRasters({ interleave: true });
    if (!(values instanceof Float32Array))
        throw new Error("Expected floating-point kilometre DEM, not an 8-bit preview");
    const raster = { width: 1440, height: 720, kilometres: values };
    validateElevationRaster(raster);
    let minimum = Infinity,
        maximum = -Infinity;
    for (const value of values) {
        minimum = Math.min(minimum, value * 1000);
        maximum = Math.max(maximum, value * 1000);
    }
    const revision = randomUUID();
    const prefix = `nasa/moon/${revision}`;
    const directory = resolve(".local/r2-nasa-moon", revision);
    const objects: IPublicationObject[] = [];
    const hashes: Record<string, string> = {};
    async function save(path: string, bytes: Uint8Array | string, contentType: string): Promise<void> {
        hashes[path] = digest(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
        await saveObject(directory, prefix, path, bytes, contentType, objects);
    }
    for (let z = 0; z <= 2; z++) {
        const rows = 2 ** z,
            width = 512 * rows,
            height = 256 * rows;
        // Resize the complete atlas before splitting it, avoiding independent tile-edge filters.
        const atlas = await sharp(colour).resize(width, height, { kernel: "lanczos3" }).png().toBuffer();
        for (let y = 0; y < rows; y++)
            for (let x = 0; x < 2 * rows; x++) {
                await save(
                    `imagery/${z}/${x}/${y}.webp`,
                    await sharp(atlas)
                        .extract({ left: x * 256, top: y * 256, width: 256, height: 256 })
                        .webp({ lossless: true })
                        .toBuffer(),
                    "image/webp",
                );
                // DEM stops at level 1: its source is 1440x720, independently of the colour raster.
                if (z <= 1) {
                    const grid = elevationGrid(raster, { z, x, y });
                    const rgba = encodeTerrariumGrid(createHeightGrid(257, 257, grid));
                    await save(
                        `dem/${z}/${x}/${y}.png`,
                        await sharp(rgba.data, { raw: { width: 257, height: 257, channels: 4 } })
                            .png()
                            .toBuffer(),
                        "image/png",
                    );
                    await save(`dem-f32/${z}/${x}/${y}.f32`, encodeFloat32Dem(grid), "application/octet-stream");
                }
            }
    }
    const radiusMetres = 1737400; // Source datum from NASA SVS, not the engine catalogue radius.
    const ranges = (max: number) =>
        Array.from({ length: max + 1 }, (_, z) => ({ z, minX: 0, maxX: 2 * 2 ** z - 1, minY: 0, maxY: 2 ** z - 1 }));
    await save(
        "source.json",
        JSON.stringify(
            {
                sourcePage,
                attribution: "NASA's Scientific Visualization Studio; LRO LROC and LOLA instrument teams",
                usage: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
                sources: sources.map((source) => ({ url: sourceBase + source.file, sha256: source.hash })),
                sourceReferenceSurface: { semiMajorAxisMetres: radiusMetres, semiMinorAxisMetres: radiusMetres },
                coordinateHandling:
                    "Native global cylindrical maps centred on longitude 0, east-positive, north at top. On the source sphere planetocentric and planetographic latitude coincide. No transform to the engine catalogue ellipsoid or rotational frame has been applied.",
                imagery: {
                    purpose: "visualization, not calibrated radiometry",
                    width: 2048,
                    height: 1024,
                    bandsNanometres: [643, 566, 415],
                    notes: "NASA white-balance and exposure adjustments, inpainted gaps, and LOLA albedo fill beyond approximately 70 degrees latitude.",
                },
                elevation: {
                    width: 1440,
                    height: 720,
                    sourceUnit: "km",
                    outputUnit: "m",
                    scale: 1000,
                    referenceRadiusMetres: radiusMetres,
                    sourceMinimumMetres: minimum,
                    sourceMaximumMetres: maximum,
                    sourceSampleRegistration: "pixel centres over [-180,180] x [-90,90]",
                    sampling:
                        "bilinear; periodic longitude; latitude clamped to source rows; exact pole vertices use the corresponding row mean",
                    noData: "No TIFF NoData tag. Finite zero values are preserved, including the zero-filled first source row; source gaps are not silently repaired.",
                    terrariumStepMetres: 1 / 256,
                    float32Url: "dem-f32/{z}/{x}/{y}.f32",
                },
            },
            null,
            2,
        ),
        "application/json",
    );
    const manifest: ITile2DManifest = {
        schema: "spacexr.tile2d/1",
        id: "moon-nasa-svs",
        bodyId: "moon",
        revision,
        instanceId: "r2-test",
        tileMatrixSet: {
            id: "spacexr-geographic-2x1",
            projection: "equirectangular",
            origin: "north-west",
            levelZeroColumns: 2,
            levelZeroRows: 1,
        },
        referenceFrame: "moon:nasa-svs-4720:native-sphere-1737400m",
        latitudeType: "planetographic",
        longitudeDirection: "east-positive",
        fallbackDatasetIds: [],
        priority: 0,
        imagery: {
            url: "imagery/{z}/{x}/{y}.webp",
            minLevel: 0,
            maxLevel: 2,
            tileSize: 256,
            encoding: "webp",
            availability: ranges(2),
            footprint: [[-180, -90, 180, 90]],
            resolutionMetres: (2 * Math.PI * radiusMetres) / 2048,
        },
        elevation: {
            url: "dem/{z}/{x}/{y}.png",
            minLevel: 0,
            maxLevel: 1,
            tileSize: 257,
            encoding: "terrarium-png",
            availability: ranges(1),
            footprint: [[-180, -90, 180, 90]],
            resolutionMetres: (2 * Math.PI * radiusMetres) / 1024,
            unit: "m",
            noData: "transparent",
            verticalDatum: "radial-height:sphere-1737400m",
            quantizationStepMetres: 1 / 256,
        },
        provenance: {
            kind: "visualization",
            source: sourcePage,
            attribution: "NASA's Scientific Visualization Studio; LRO LROC and LOLA",
            license: "NASA media usage guidelines; see source.json",
            verified: true,
        },
        contentHashes: { ...hashes },
        publishedAt: new Date().toISOString(),
    };
    validateManifest(manifest);
    await save("manifest.json", JSON.stringify(manifest, null, 2), "application/json");
    const preview = await readFile(resolve("tools/r2/moon-preview.html"), "utf8");
    await save("index.html", preview, "text/html; charset=utf-8");
    const receipt = { bucket: bucket ?? "", prefix, objects };
    await mkdir(resolve(".local/r2-nasa-moon"), { recursive: true });
    await writeFile(resolve(".local/r2-nasa-moon/latest.json"), JSON.stringify(receipt, null, 2));
    if (bucket) await uploadPublication(receipt);
    console.log(
        JSON.stringify(
            {
                bucket,
                prefix,
                objects: objects.length,
                minimumMetres: minimum,
                maximumMetres: maximum,
                preview: `${prefix}/index.html`,
            },
            null,
            2,
        ),
    );
}
await main();

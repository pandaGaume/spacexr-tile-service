import { readFile, stat } from "node:fs/promises";
import { fromFile } from "geotiff";
import { hashFile, storagePath, writeJson } from "../../lunar/storage";

/** Radius of the Mars 2000 sphere of the MoRIC mosaic, in metres. */
export const MORIC_SPHERE_RADIUS = 3396190;

/** Tianwen-1 MoRIC global colour mosaic, its origin and the credit its use requires. */
export const MORIC = {
    id: "tianwen1-moric-76m",
    file: "Tianwen-1/HX1_GRAS_MoRIC_DOM_076m_Global_00N00E_A.tif",
    url: "https://moon.bao.ac.cn/WEBDATA/HX1ROLL/HX1/MoRIC/GLOBAL/2023-11/HX1_GRAS_MoRIC_DOM_076m_Global_00N00E_A.tif",
    credit: "J. Liu, X. Ren, W. Yan et al., A 76-m per pixel global color image dataset and map of Mars by Tianwen-1, Science Bulletin, https://doi.org/10.1016/j.scib.2024.04.045",
    rights: "Public data of the China Lunar and Planetary Data Release System (CLPDS), copyright NAOC/GRAS; the citation above is required wherever the mosaic is used.",
} as const;

/**
 * A raster in simple cylindrical projection (Plate Carree, central meridian 0, east-positive longitude) on a sphere,
 * with square pixels that cover their area. Coordinates are projected metres: `x = longitude * radius`,
 * `y = latitude * radius`, both in radians.
 */
export interface IPlateCarree {
    width: number;
    height: number;
    /** Projected metres of the west edge of the first column. */
    originX: number;
    /** Projected metres of the north edge of the first row. */
    originY: number;
    pixelMetres: number;
    sphereRadius: number;
}

/** Manifest of a source file, written beside it; the source itself is never modified. */
export interface IMoricSourceManifest {
    schema: "mars-source/1";
    id: string;
    file: string;
    url: string;
    credit: string;
    rights: string;
    bytes: number;
    sha256: string;
    projection: string;
    geometry: IPlateCarree;
    bands: "RGB 8-bit";
    noData: string;
    longitude: string;
}

/**
 * Reads and checks the geometry of the MoRIC GeoTIFF: three 8-bit bands, Plate Carree on the Mars 2000 sphere with
 * central meridian 0, square pixels whose values cover their area.
 *
 * @throws Error When the file is not the raster these tools are written for.
 */
export async function readMoricGeometry(file: string): Promise<IPlateCarree> {
    const image = await (await fromFile(file)).getImage(0);
    const keys = image.getGeoKeys() as Record<string, unknown>;
    const [originX, originY] = image.getOrigin();
    const [resolutionX, resolutionY] = image.getResolution();
    const bits = (await image.fileDirectory.loadValue("BitsPerSample")) as ArrayLike<number>;
    if (image.getSamplesPerPixel() !== 3 || Array.from(bits).some((value) => value !== 8))
        throw new Error("MoRIC must hold three 8-bit bands.");
    if (keys.ProjCoordTransGeoKey !== 17 || keys.ProjCenterLongGeoKey !== 0 || keys.ProjLinearUnitsGeoKey !== 9001)
        throw new Error("MoRIC must be in Plate Carree, central meridian 0, in metres.");
    if (keys.GeogSemiMajorAxisGeoKey !== MORIC_SPHERE_RADIUS || keys.GeogSemiMinorAxisGeoKey !== MORIC_SPHERE_RADIUS)
        throw new Error("MoRIC must lie on the Mars 2000 sphere.");
    if (keys.GTRasterTypeGeoKey !== 1) throw new Error("MoRIC pixels must cover their area.");
    if (resolutionX !== -resolutionY! || resolutionX! <= 0) throw new Error("MoRIC pixels must be square.");
    return {
        width: image.getWidth(),
        height: image.getHeight(),
        originX: originX!,
        originY: originY!,
        pixelMetres: resolutionX!,
        sphereRadius: MORIC_SPHERE_RADIUS,
    };
}

/**
 * The manifest of the MoRIC source, written beside it on the first call: its SHA-256 takes one full read of the file.
 * A manifest whose size no longer matches the file is rebuilt.
 */
export async function moricSourceManifest(root: string): Promise<IMoricSourceManifest> {
    const file = storagePath(root, MORIC.file);
    const manifestPath = file.replace(/\.tif$/, ".source.json");
    const { size } = await stat(file);
    try {
        const previous = JSON.parse(await readFile(manifestPath, "utf8")) as IMoricSourceManifest;
        if (previous.schema === "mars-source/1" && previous.bytes === size) {
            // The hash stands while the file keeps its size; its description follows these tools.
            const current = { ...previous, url: MORIC.url, credit: MORIC.credit, rights: MORIC.rights };
            if (JSON.stringify(current) !== JSON.stringify(previous)) await writeJson(manifestPath, current);
            return current;
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    console.log(`Hashing ${MORIC.file} (${(size / 1e9).toFixed(1)} GB)...`);
    const manifest: IMoricSourceManifest = {
        schema: "mars-source/1",
        id: MORIC.id,
        file: MORIC.file,
        url: MORIC.url,
        credit: MORIC.credit,
        rights: MORIC.rights,
        bytes: size,
        sha256: await hashFile(file),
        projection: "Mars_Plate_Carree, GCS_Mars_2000_Sphere, central meridian 0",
        geometry: await readMoricGeometry(file),
        bands: "RGB 8-bit",
        noData: "none: GDAL_NODATA is 256, outside the 8-bit range; pixels that are black in all three bands are counted by the pyramid",
        longitude: "east-positive, -180 to 180",
    };
    await writeJson(manifestPath, manifest);
    return manifest;
}

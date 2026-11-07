import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import { fromFile } from "geotiff";
import { createHeightGrid, encodeTerrariumGrid } from "@spacexr/dem";
import { cubeFaceCoordinates, cubeFaceDirection, CubeFace } from "@spacexr/tiles/cube";

const TILE_SIZE = 256;
const MOLA_ROOT = "F:/MarsData/sources/mola/meg004";
const DEFAULT_ROOT = "F:/MarsData";
const ELLIPSOID_A = 3396190;
const ELLIPSOID_C = 3376200;

interface IRaster {
    width: number;
    height: number;
    originX: number;
    originY: number;
    pixelX: number;
    pixelY: number;
    noData: number;
    standardParallel: number;
    values: Float32Array;
}

interface IBounds { minLat: number; maxLat: number; minLon: number; maxLon: number; }

function sha256(data: Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }

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
            width: image.getWidth(), height: image.getHeight(), originX: origin[0]!, originY: origin[1]!,
            pixelX: resolution[0]!, pixelY: Math.abs(resolution[1]!), noData: Number(image.getGDALNoData()),
            standardParallel: Number(keys?.ProjStdParallel1GeoKey ?? 0), values,
        };
    } finally { await tiff.close(); }
}

function sampleRaster(raster: IRaster, x: number, y: number): number {
    const px = (x - raster.originX) / raster.pixelX - 0.5;
    const py = (raster.originY - y) / raster.pixelY - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
    let sum = 0, weight = 0;
    for (const [dx, dy, w] of [[0, 0, (1-fx)*(1-fy)], [1, 0, fx*(1-fy)], [0, 1, (1-fx)*fy], [1, 1, fx*fy]] as const) {
        const x = x0 + dx, y = y0 + dy;
        if (!w || x < 0 || y < 0 || x >= raster.width || y >= raster.height) continue;
        const value = raster.values[y * raster.width + x]!;
        if (!Number.isFinite(value) || value === raster.noData) continue;
        sum += value * w; weight += w;
    }
    return weight ? sum / weight : Number.NaN;
}

function smoothstep(value: number): number {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
}

function sourceXY(latitude: number, longitude: number, parallel: number): [number, number] {
    const radius = 3396190, p = parallel * Math.PI / 180;
    return [longitude * Math.PI / 180 * radius * Math.cos(p), latitude * Math.PI / 180 * radius];
}

function sourceBounds(raster: IRaster): IBounds {
    const corners = [
        [raster.originX, raster.originY],
        [raster.originX + raster.width * raster.pixelX, raster.originY],
        [raster.originX, raster.originY - raster.height * raster.pixelY],
        [raster.originX + raster.width * raster.pixelX, raster.originY - raster.height * raster.pixelY],
    ];
    const parallel = raster.standardParallel * Math.PI / 180;
    const lats = corners.map(([, y]) => y! / 3396190 * 180 / Math.PI);
    const lons = corners.map(([x]) => x! / (3396190 * Math.cos(parallel)) * 180 / Math.PI);
    return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };
}

function addresses(bounds: IBounds, lod: number): Array<{ face: CubeFace; lod: number; x: number; y: number }> {
    const positions = [
        [bounds.minLat, bounds.minLon], [bounds.minLat, bounds.maxLon],
        [bounds.maxLat, bounds.minLon], [bounds.maxLat, bounds.maxLon],
    ].map(([lat, lon]) => {
        const p = lat! * Math.PI / 180, l = lon! * Math.PI / 180;
        return cubeFaceCoordinates({ x: Math.cos(p)*Math.cos(l), y: Math.cos(p)*Math.sin(l), z: Math.sin(p) });
    });
    const face = positions[0]!.face;
    if (face !== CubeFace.PositiveY || positions.some((p) => p.face !== face)) throw new Error("Jezero extent spans multiple cube faces.");
    const n = 2 ** lod;
    const minX = Math.max(0, Math.floor(Math.min(...positions.map((p) => p.u))*n)-1);
    const maxX = Math.min(n-1, Math.floor(Math.max(...positions.map((p) => p.u))*n)+1);
    const minY = Math.max(0, Math.floor(Math.min(...positions.map((p) => p.v))*n)-1);
    const maxY = Math.min(n-1, Math.floor(Math.max(...positions.map((p) => p.v))*n)+1);
    const result = [];
    for (let y=minY; y<=maxY; y++) for (let x=minX; x<=maxX; x++) result.push({ face, lod, x, y });
    return result;
}

interface IMolaGrid { values: Int16Array; radius: boolean; }

/**
 * Load one native MOLA 4 ppd global grid from its PDS big-endian signed samples.
 * The low-frequency grid is used for the areoid relationship. Local stereo DEMs
 * provide the finer terrain, while MOLA supplies the common vertical reference.
 */
async function loadMolaGrid(kind: "megr" | "megt"): Promise<IMolaGrid> {
    const file = resolve(MOLA_ROOT, `${kind}90n000cb.img`);
    const bytes = await readFile(file);
    if (bytes.length !== 720 * 1440 * 2) throw new Error(`Invalid MOLA raster ${file}`);
    const values = new Int16Array(bytes.length / 2);
    for (let i=0; i<values.length; i++) values[i] = bytes.readInt16BE(i*2);
    return { values, radius: kind === "megr" };
}

/** Bilinearly sample a global, pixel-centred MOLA grid at planetocentric coordinates. */
function sampleMola(grid: IMolaGrid, latitude: number, longitude: number): number {
    const normalizedLongitude=((longitude%360)+360)%360;
    const x = normalizedLongitude * 4 - 0.5;
    const y = (90 - latitude) * 4 - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx=x-x0, fy=y-y0;
    let total=0;
    for (const [dx,dy,w] of [[0,0,(1-fx)*(1-fy)],[1,0,fx*(1-fy)],[0,1,(1-fx)*fy],[1,1,fx*fy]] as const) {
        const col=x0+dx, row=y0+dy;
        const wrappedColumn=(col+1440)%1440;
        if (row<0 || row>=720) continue;
        total += (grid.values[row*1440+wrappedColumn]! * w);
    }
    return total + (grid.radius ? 3396000 : 0);
}

/**
 * Reproject one local DEM onto only the cube tiles intersecting its footprint.
 * Heights are moved from the MOLA areoid onto the Mars ellipsoid along each
 * planetocentric direction. A 40-pixel edge blend falls back to the global MOLA
 * topography, avoiding a hard discontinuity where a regional source ends.
 */
async function buildTiles(root: string, id: string, raster: IRaster, sourceBoundsValue: IBounds, minLOD: number, maxLOD: number,
    megr: IMolaGrid, megt: IMolaGrid): Promise<object[]> {
    const files: object[]=[];
    const invA=1/(ELLIPSOID_A*ELLIPSOID_A), invC=1/(ELLIPSOID_C*ELLIPSOID_C);
    for (let lod=minLOD; lod<=maxLOD; lod++) for (const tile of addresses(sourceBoundsValue,lod)) {
        const heights=new Float32Array((TILE_SIZE+1)**2); let min=Infinity,max=-Infinity;
        for(let row=0;row<=TILE_SIZE;row++) for(let col=0;col<=TILE_SIZE;col++) {
            const dir=cubeFaceDirection(tile.face,(tile.x+col/TILE_SIZE)/2**lod,(tile.y+row/TILE_SIZE)/2**lod);
            const lat=Math.atan2(dir.z,Math.hypot(dir.x,dir.y))*180/Math.PI;
            let lon=Math.atan2(dir.y,dir.x)*180/Math.PI; if(lon<0) lon+=360;
            const [sx,sy]=sourceXY(lat,lon,raster.standardParallel);
            const source=sampleRaster(raster,sx,sy);
            const px=(sx-raster.originX)/raster.pixelX;
            const py=(raster.originY-sy)/raster.pixelY;
            const edgePixels=Math.min(px,py,raster.width-px,raster.height-py);
            const coverage=Number.isFinite(source)?smoothstep(edgePixels/40):0;
            const fallback=sampleMola(megt,lat,lon);
            const regional=Number.isFinite(source)?source:fallback;
            const geoidRadius=sampleMola(megr,lat,lon)-sampleMola(megt,lat,lon);
            const ellipsoidRadius=1/Math.sqrt((dir.x*dir.x+dir.y*dir.y)*invA+dir.z*dir.z*invC);
            const height=geoidRadius + fallback*(1-coverage) + regional*coverage - ellipsoidRadius;
            heights[row*(TILE_SIZE+1)+col]=height; min=Math.min(min,height); max=Math.max(max,height);
        }
        const image=encodeTerrariumGrid(createHeightGrid(TILE_SIZE+1,TILE_SIZE+1,heights));
        const bytes=await sharp(image.data,{raw:{width:TILE_SIZE+1,height:TILE_SIZE+1,channels:4}}).png({compressionLevel:4}).toBuffer();
        const path=`datasets/mars/jezero/${id}/elevation/${tile.face}/${lod}/${tile.x}/${tile.y}.png`;
        const full=resolve(root,path); await mkdir(dirname(full),{recursive:true}); await writeFile(full,bytes);
        files.push({...tile,minHeight:min,maxHeight:max,path,bytes:bytes.length,sha256:sha256(bytes)});
    }
    return files;
}

/**
 * Build an experimental CTX correction as a separate tile source.
 * The source must use the same grid and georeferencing as the original CTX DEM.
 * The original tiles remain available for direct visual comparison.
 *
 * @param root - Mars data directory containing the original CTX tiles and manifest.
 */
export async function buildJezeroCtxCorrection(root=DEFAULT_ROOT): Promise<void> {
    const originalPath=resolve(root,"sources/jezero/ctx/M20_JezeroCrater_CTXDEM_20m.tif");
    const correctedPath=resolve(root,"sources/jezero/ctx/Jezero_CTXDEM_20m_correction_experimentale.tif");
    const [original,corrected,megr,megt]=await Promise.all([loadGeoTiff(originalPath),loadGeoTiff(correctedPath),loadMolaGrid("megr"),loadMolaGrid("megt")]);
    const sameGrid=original.width===corrected.width&&original.height===corrected.height&&original.originX===corrected.originX&&original.originY===corrected.originY&&original.pixelX===corrected.pixelX&&original.pixelY===corrected.pixelY&&original.standardParallel===corrected.standardParallel;
    if(!sameGrid) throw new Error("Corrected CTX GeoTIFF grid differs from the original; refusing to generate misregistered tiles.");
    const ctxBounds={minLat:17.58,maxLat:19.29,minLon:76.99,maxLon:78.58};
    const tiles=await buildTiles(root,"ctx-20m-corrected",corrected,ctxBounds,7,10,megr,megt);
    const manifestPath=resolve(root,"datasets/mars/jezero/manifest.json");
    const manifest=JSON.parse(await readFile(manifestPath,"utf8")) as {sources:Array<Record<string,unknown>>;generatedAt?:string};
    manifest.sources=manifest.sources.filter((source)=>source.id!=="ctx-20m-corrected");
    manifest.sources.push({id:"ctx-20m-corrected",resolutionMetres:20,file:correctedPath,bytes:(await stat(correctedPath)).size,parentSource:"ctx-20m",quality:"experimental, not scientifically validated",tiles});
    manifest.generatedAt=new Date().toISOString();
    await writeFile(manifestPath,JSON.stringify(manifest,null,2)+"\n");
    console.log(`Jezero corrected CTX: ${tiles.length} experimental DEM tiles written to ${manifestPath}`);
}
/**
 * Build the Jezero regional DEM refinement as Terrarium-encoded cube tiles.
 * CTX supplies continuous crater coverage; HiRISE extends the rover landing
 * region to metre scale. The output manifest records the exact tile inventory.
 *
 * @param root - Mars data directory containing imported source rasters.
 * @param maxHiRISELOD - Finest cube level generated for the HiRISE product.
 */
export async function buildJezeroRefinement(root=DEFAULT_ROOT,maxHiRISELOD=14): Promise<void> {
    if(!Number.isInteger(maxHiRISELOD)||maxHiRISELOD<11||maxHiRISELOD>16) throw new RangeError("HiRISE max LOD must be 11..16.");
    const ctxPath=resolve(root,"sources/jezero/ctx/M20_JezeroCrater_CTXDEM_20m.tif");
    const hiPath=resolve(root,"sources/jezero/hirise/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif");
    const [ctx,hi,megr,megt]=await Promise.all([loadGeoTiff(ctxPath),loadGeoTiff(hiPath),loadMolaGrid("megr"),loadMolaGrid("megt")]);
    const ctxBounds={minLat:17.58,maxLat:19.29,minLon:76.99,maxLon:78.58};
    const hiriseBounds=sourceBounds(hi);
    const ctxTiles=await buildTiles(root,"ctx-20m",ctx,ctxBounds,7,10,megr,megt);
    const hiTiles=await buildTiles(root,"hirise-1m",hi,hiriseBounds,11,maxHiRISELOD,megr,megt);
    const manifest={schema:"mars-jezero-refinement/1",body:"Mars",region:"Jezero crater",projection:"planetocentric equirectangular",verticalDatum:"MOLA areoid, radius reconstructed from the smoothed 4 ppd MEGR and MEGT products",tileSize:TILE_SIZE,
        tileUrlTemplate:"/mars/datasets/mars/jezero/{source}/elevation/{face}/{lod}/{x}/{y}.png",
        sources:[{id:"ctx-20m",resolutionMetres:20,url:"https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.tif",file:ctxPath,bytes:(await stat(ctxPath)).size,tiles:ctxTiles},{id:"hirise-1m",resolutionMetres:1,url:"https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif",file:hiPath,bytes:(await stat(hiPath)).size,tiles:hiTiles}],
        geoidSources:[
            {id:"MOLA MEGR 4 ppd",file:resolve(MOLA_ROOT,"megr90n000cb.img"),url:"https://pds-geosciences.wustl.edu/missions/mgs/megdr.html"},
            {id:"MOLA MEGT 4 ppd",file:resolve(MOLA_ROOT,"megt90n000cb.img"),url:"https://pds-geosciences.wustl.edu/missions/mgs/megdr.html"},
        ],generatedAt:new Date().toISOString()};
    const file=resolve(root,"datasets/mars/jezero/manifest.json"); await mkdir(dirname(file),{recursive:true}); await writeFile(file,JSON.stringify(manifest,null,2)+"\n");
    console.log(`Jezero: ${ctxTiles.length+hiTiles.length} DEM tiles written to ${file}`);
}

import sharp from "sharp";
import {createHeightGrid,encodeTerrariumGrid} from "@spacexr/dem";
import {tileCount} from "@spacexr/tiles/addressing";
import {encodeFloat32Dem,vertexAtDegrees,addressesInRange,validateManifest,type IGeographicTileAddress} from "@spacexr-service/tile2d-core";
import {sha256,type ITile2DManifest,type IBodyReference,type IAvailabilityRange} from "@spacexr-service/shared";
/** One immutable generated object. Consumers can upload it before requesting the next tile. */
export interface IBuiltObject {path:string;bytes:Uint8Array;contentType:string;sha256:string;}
/** Explicit synthetic fixture, never a substitute for a scientific product. */
export interface ISyntheticDatasetOptions {instanceId:string;id:string;revision:string;body:IBodyReference;maxLevel:number;channels?:"both"|"imagery"|"dem";terrarium?:boolean;ranges?:readonly IAvailabilityRange[];fallbackDatasetIds?:string[];priority?:number;maxTiles?:number;}
/** Smooth periodic synthetic elevation in metres, independent of any real planetary data. */
export function syntheticHeight(latitudeDegrees:number,longitudeDegrees:number):number{const lat=latitudeDegrees*Math.PI/180,lon=longitudeDegrees*Math.PI/180;return 500*Math.cos(lat)**2*Math.sin(2*lon)+100*Math.sin(lat);}
/** A canonical 257-square shared-border height grid. */
export function syntheticHeightGrid(address:IGeographicTileAddress):Float32Array{const data=new Float32Array(257*257);for(let row=0;row<=256;row++)for(let column=0;column<=256;column++){const point=vertexAtDegrees(address,column,row);data[row*257+column]=syntheticHeight(point.latitude,point.longitude);}return data;}
/** Build small deterministic fixtures incrementally, with explicit limits and provenance. */
export async function* buildSyntheticDataset(options:ISyntheticDatasetOptions):AsyncGenerator<IBuiltObject>{
 if(!Number.isInteger(options.maxLevel)||options.maxLevel<0||options.maxLevel>12)throw new RangeError("Synthetic level must be an integer from 0 to 12");
 const ranges=options.ranges?[...options.ranges]:Array.from({length:options.maxLevel+1},(_,z)=>({z,minX:0,maxX:2*tileCount(z)-1,minY:0,maxY:tileCount(z)-1}));
 let tiles=0;for(const range of ranges)tiles+=(range.maxX-range.minX+1)*(range.maxY-range.minY+1);if(tiles>(options.maxTiles??1000))throw new RangeError("Synthetic dataset exceeds the requested tile budget");
 const hashes:Record<string,string>={};
 async function object(path:string,bytes:Uint8Array,contentType:string):Promise<IBuiltObject>{const hash=await sha256(bytes);hashes[path]=hash;return{path,bytes,contentType,sha256:hash};}
 const channels=options.channels??"both";
 for(const range of ranges)for(const address of addressesInRange(range)){
  if(channels!=="dem"){
   const rgb=new Uint8Array(256*256*3);
   for(let row=0;row<256;row++)for(let col=0;col<256;col++){const p=vertexAtDegrees(address,col,row);const i=(row*256+col)*3;rgb[i]=Math.round((p.longitude+180)/360*255);rgb[i+1]=Math.round((p.latitude+90)/180*255);rgb[i+2]=100;}
   const encoded=new Uint8Array(await sharp(rgb,{raw:{width:256,height:256,channels:3}}).webp({quality:80}).toBuffer());
   yield await object("imagery/"+address.z+"/"+address.x+"/"+address.y+".webp",encoded,"image/webp");
  }
  if(channels!=="imagery"){
   const data=syntheticHeightGrid(address);
   if(options.terrarium){const pixels=encodeTerrariumGrid(createHeightGrid(257,257,data));const png=new Uint8Array(await sharp(pixels.data,{raw:{width:257,height:257,channels:4}}).png().toBuffer());yield await object("dem/"+address.z+"/"+address.x+"/"+address.y+".png",png,"image/png");}
   else yield await object("dem/"+address.z+"/"+address.x+"/"+address.y+".f32",encodeFloat32Dem(data),"application/octet-stream");
  }
 }
 const minLevel=Math.min(...ranges.map(r=>r.z)),maxLevel=Math.max(...ranges.map(r=>r.z));
 const base={minLevel,maxLevel,availability:ranges,footprint:[[-180,-90,180,90] as [number,number,number,number]],resolutionMetres:2*Math.PI*options.body.semiMajorAxisMetres/(2*tileCount(maxLevel)*256)};
 const manifest:ITile2DManifest={schema:"spacexr.tile2d/1",id:options.id,revision:options.revision,instanceId:options.instanceId,bodyId:options.body.id,tileMatrixSet:{id:"spacexr-geographic-2x1",projection:"equirectangular",origin:"north-west",levelZeroColumns:2,levelZeroRows:1},referenceFrame:options.body.profile.referenceFrame,latitudeType:"planetographic",longitudeDirection:"east-positive",fallbackDatasetIds:options.fallbackDatasetIds??[],priority:options.priority??0,provenance:{kind:"synthetic",source:"Analytical periodic fixture",attribution:"Synthetic test data",license:"CC0-1.0",verified:true},contentHashes:hashes,publishedAt:new Date(0).toISOString()};
 if(channels!=="dem")manifest.imagery={...base,url:"imagery/{z}/{x}/{y}.webp",tileSize:256,encoding:"webp"};
 if(channels!=="imagery")manifest.elevation={...base,url:options.terrarium?"dem/{z}/{x}/{y}.png":"dem/{z}/{x}/{y}.f32",tileSize:257,encoding:options.terrarium?"terrarium-png":"float32-le",unit:"m",noData:options.terrarium?"transparent":"NaN",verticalDatum:options.body.profile.verticalDatum,...options.terrarium?{quantizationStepMetres:1/256}:{}};
 validateManifest(manifest);const bytes=new TextEncoder().encode(JSON.stringify(manifest));yield{path:"manifest.json",bytes,contentType:"application/json",sha256:await sha256(bytes)};
}

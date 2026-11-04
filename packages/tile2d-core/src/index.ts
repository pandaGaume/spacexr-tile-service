import {assertValidTileAddress,tileCount,parentTileAddress,childTileAddresses,type ITileAddress} from "@spacexr/tiles/addressing";
import {parseSchema,ServiceError,Tile2DManifestSchema,type ITile2DManifest,type ITileChannel,type IAvailabilityRange} from "@spacexr-service/shared";
/** Geographic 2x1 address. It is not an unadapted 1x1 XYZ address. */
export interface IGeographicTileAddress {z:number;x:number;y:number;}
/** Angular bounds in degrees, west/south/east/north. */
export type GeographicExtent=readonly[number,number,number,number];
/** Two independent roots share the established local quadtree addressing primitives. */
export function splitAddress(address:IGeographicTileAddress):{root:0|1;local:ITileAddress}{
 const {z,x,y}=address;if(!Number.isInteger(z)||z<0||z>24||!Number.isSafeInteger(x)||x<0)throw new RangeError("Invalid geographic tile address");
 const count=tileCount(z),root=Math.floor(x/count);if(root!==0&&root!==1)throw new RangeError("Geographic column is outside the 2x1 matrix");
 const local={lod:z,x:x-root*count,y};assertValidTileAddress(local);return{root,local};
}
/** Join a validated hemispheric local address into the canonical 2x1 matrix. */
export function joinAddress(root:0|1,local:ITileAddress):IGeographicTileAddress{assertValidTileAddress(local);const result={z:local.lod,x:root*tileCount(local.lod)+local.x,y:local.y};splitAddress(result);return result;}
/** Parent preserves the level-zero hemispheric root. */
export function parentAddress(address:IGeographicTileAddress):IGeographicTileAddress|undefined{const{root,local}=splitAddress(address);const parent=parentTileAddress(local);return parent?joinAddress(root,parent):undefined;}
/** Four children use the common north-west, north-east, south-west, south-east order. */
export function childAddresses(address:IGeographicTileAddress):IGeographicTileAddress[]{const{root,local}=splitAddress(address);if(address.z===24)throw new RangeError("Configured geographic level limit reached");return childTileAddresses(local).map(child=>joinAddress(root,child));}
/** Canonical half-open longitude convention: +180 and -180 identify the same meridian. Latitude never wraps. */
export function normalizeLongitude(longitude:number):number{if(!Number.isFinite(longitude))throw new RangeError("Longitude must be finite");return((longitude+180)%360+360)%360-180;}
/** Locate a geographic point; north and south poles map to the first and last row respectively. */
export function tileAtDegrees(latitude:number,longitude:number,z:number):IGeographicTileAddress{
 if(!Number.isFinite(latitude)||Math.abs(latitude)>90||!Number.isInteger(z)||z<0||z>24)throw new RangeError("Invalid latitude or level");
 const rows=tileCount(z),columns=2*rows;
 const address={z,x:Math.min(columns-1,Math.floor((normalizeLongitude(longitude)+180)/360*columns)),y:Math.min(rows-1,Math.floor((90-latitude)/180*rows))};splitAddress(address);return address;
}
/** Exact angular bounds of one geographic tile, including polar coverage. */
export function tileExtent(address:IGeographicTileAddress):GeographicExtent{splitAddress(address);const size=180/tileCount(address.z);return[-180+address.x*size,90-(address.y+1)*size,-180+(address.x+1)*size,90-address.y*size];}
/** Vertex-grid sample position from a shared global integer lattice, preserving adjacent borders bit-for-bit. */
export function vertexAtDegrees(address:IGeographicTileAddress,column:number,row:number,cells=256):{longitude:number;latitude:number}{
 splitAddress(address);if(!Number.isInteger(cells)||cells<1||!Number.isInteger(column)||!Number.isInteger(row)||column<0||row<0||column>cells||row>cells)throw new RangeError("Invalid vertex coordinate");
 const northSouthCells=tileCount(address.z)*cells;
 return{longitude:-180+(address.x*cells+column)/(2*northSouthCells)*360,latitude:90-(address.y*cells+row)/northSouthCells*180};
}
/** Availability is authoritative; a missing tile does not need an HTTP probe. */
export function hasTile(channel:ITileChannel,address:IGeographicTileAddress):boolean{
 splitAddress(address);return address.z>=channel.minLevel&&address.z<=channel.maxLevel&&channel.availability.some(range=>range.z===address.z&&address.x>=range.minX&&address.x<=range.maxX&&address.y>=range.minY&&address.y<=range.maxY);
}
/** Validate both the shared schema and spatial/numerical invariants. */
export function validateManifest(input:unknown):ITile2DManifest{
 const manifest=parseSchema(Tile2DManifestSchema,input);
 if(!manifest.imagery&&!manifest.elevation)throw new ServiceError(400,"EMPTY_DATASET","A dataset needs imagery or elevation");
 for(const[kind,channel]of [["imagery",manifest.imagery],["dem",manifest.elevation]]as const){
  if(!channel)continue;
  if(channel.minLevel>channel.maxLevel)throw new ServiceError(400,"INVALID_LEVELS","Minimum zoom exceeds maximum zoom");
  if(!channel.url.includes("{z}")||!channel.url.includes("{x}")||!channel.url.includes("{y}")||channel.url.startsWith("/")||channel.url.includes("..")||channel.url.includes(":")||channel.url.includes("\\"))throw new ServiceError(400,"INVALID_TEMPLATE","Tile paths must be safe relative z/x/y templates");
  if(kind==="imagery"&&(channel.tileSize===257||!['webp','jpeg'].includes(channel.encoding)))throw new ServiceError(400,"INVALID_IMAGERY","Imagery requires 256/512 pixels and WebP/JPEG encoding");
  if(kind==="dem"&&(channel.tileSize!==257||!['float32-le','terrarium-png'].includes(channel.encoding)||channel.unit!=="m"||!channel.verticalDatum))throw new ServiceError(400,"INVALID_DEM","DEM requires a 257 sample grid, lossless encoding, metres and explicit vertical datum");
  if(kind==="dem"&&channel.encoding==="float32-le"&&channel.noData!=="NaN")throw new ServiceError(400,"INVALID_NODATA","Float32 DEM requires explicit NaN NoData");
  if(kind==="dem"&&channel.encoding==="terrarium-png"&&(channel.noData!=="transparent"||channel.quantizationStepMetres!==1/256))throw new ServiceError(400,"INVALID_QUANTIZATION","Terrarium requires transparent NoData and its 1/256 metre step");
  for(const bounds of channel.footprint)if(bounds[0]>=bounds[2]||bounds[1]>=bounds[3])throw new ServiceError(400,"INVALID_FOOTPRINT","Extent must have west < east and south < north; split antimeridian extents");
  for(const range of channel.availability){if(range.minX>range.maxX||range.minY>range.maxY||range.z<channel.minLevel||range.z>channel.maxLevel)throw new ServiceError(400,"INVALID_AVAILABILITY","Availability range is inconsistent");splitAddress({z:range.z,x:range.minX,y:range.minY});splitAddress({z:range.z,x:range.maxX,y:range.maxY});}
 }
 if(manifest.fallbackDatasetIds.includes(manifest.id))throw new ServiceError(400,"CYCLIC_FALLBACK","A dataset cannot fall back to itself");
 if(!manifest.provenance.verified)throw new ServiceError(400,"UNVERIFIED_DATASET","Only verified generated datasets can be published");
 if(!Number.isFinite(Date.parse(manifest.publishedAt)))throw new ServiceError(400,"INVALID_PUBLICATION_DATE","Publication time is invalid");
 return manifest;
}
/** Source selection includes the ancestor address and UV sub-area; a parent redirect alone is insufficient for overzoom. */
export interface ITileSelection {datasetId:string;revision:string;address:IGeographicTileAddress;relativePath:string;uv:{west:number;north:number;width:number;height:number};}
/** Select published HD/LOW content by explicit fallback graph and availability, without any network probing. */
export function selectTile(datasetId:string,kind:"imagery"|"dem",requested:IGeographicTileAddress,manifests:ReadonlyMap<string,ITile2DManifest>):ITileSelection|undefined{
 splitAddress(requested);const visiting=new Set<string>();
 function select(id:string):ITileSelection|undefined{
  if(visiting.has(id))throw new ServiceError(400,"CYCLIC_FALLBACK","Dataset fallback graph contains a cycle");
  const manifest=manifests.get(id);if(!manifest)return undefined;visiting.add(id);
  const channel=kind==="imagery"?manifest.imagery:manifest.elevation;
  if(channel){let source:IGeographicTileAddress|undefined=requested;while(source){if(hasTile(channel,source)){
   const divisor=2**(requested.z-source.z);visiting.delete(id);
   return{datasetId:id,revision:manifest.revision,address:source,relativePath:channel.url.replaceAll("{z}",String(source.z)).replaceAll("{x}",String(source.x)).replaceAll("{y}",String(source.y)),uv:{west:(requested.x-source.x*divisor)/divisor,north:(requested.y-source.y*divisor)/divisor,width:1/divisor,height:1/divisor}};
  }source=parentAddress(source);}}
  for(const fallback of manifest.fallbackDatasetIds){const result=select(fallback);if(result){visiting.delete(id);return result;}}
  visiting.delete(id);return undefined;
 }
 return select(datasetId);
}
/** Enumerate configured availability in bounded row order without materializing a pyramid. */
export function* addressesInRange(range:IAvailabilityRange):Generator<IGeographicTileAddress>{splitAddress({z:range.z,x:range.minX,y:range.minY});splitAddress({z:range.z,x:range.maxX,y:range.maxY});for(let y=range.minY;y<=range.maxY;y++)for(let x=range.minX;x<=range.maxX;x++)yield{z:range.z,x,y};}
/** Canonical raw Float32 little-endian wire format with quiet NaN NoData, independent of host byte order. */
export function encodeFloat32Dem(samples:Float32Array|Float64Array):Uint8Array{const bytes=new Uint8Array(samples.length*4),view=new DataView(bytes.buffer);for(let i=0;i<samples.length;i++){const sample=samples[i]!;if(Number.isNaN(sample))view.setUint32(i*4,0x7fc00000,true);else{if(!Number.isFinite(sample))throw new RangeError("DEM heights must be finite metres or NaN");view.setFloat32(i*4,sample,true);if(!Number.isFinite(view.getFloat32(i*4,true)))throw new RangeError("Height exceeds Float32 range");}}return bytes;}
/** Decode an exact raw little-endian grid; dimensions and datum come from its manifest. */
export function decodeFloat32Dem(bytes:Uint8Array,sampleCount=257*257):Float32Array{if(bytes.byteLength!==sampleCount*4)throw new RangeError("Unexpected DEM byte length");const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),samples=new Float32Array(sampleCount);for(let i=0;i<sampleCount;i++){samples[i]=view.getFloat32(i*4,true);if(!Number.isFinite(samples[i])&&!Number.isNaN(samples[i]))throw new RangeError("Infinite DEM height is invalid");}return samples;}

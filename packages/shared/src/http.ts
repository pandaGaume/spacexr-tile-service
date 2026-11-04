import {ServiceError} from "./errors";
/** Bounded request reader. A misleading Content-Length never bypasses the actual byte limit. */
export async function readBytes(request:Request,maximum:number):Promise<Uint8Array>{
 if(Number(request.headers.get("content-length")??0)>maximum)throw new ServiceError(413,"PAYLOAD_TOO_LARGE","Payload exceeds configured limit");if(!request.body)return new Uint8Array();const reader=request.body.getReader(),parts:Uint8Array[]=[];let size=0;
 try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum){await reader.cancel();throw new ServiceError(413,"PAYLOAD_TOO_LARGE","Payload exceeds configured limit");}parts.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}return bytes;
}
/** Parse JSON with bounded depth and size before schema validation. */
export async function readJson(request:Request):Promise<unknown>{
 if(!request.headers.get("content-type")?.startsWith("application/json"))throw new ServiceError(415,"JSON_REQUIRED","Content-Type application/json is required");
 let value:unknown;try{value=JSON.parse(new TextDecoder().decode(await readBytes(request,1048576))) as unknown;}catch(error){if(error instanceof ServiceError)throw error;throw new ServiceError(400,"INVALID_JSON","Malformed JSON");}
 const pending:[unknown,number][]=[[value,0]];let count=0;while(pending.length){const[item,depth]=pending.pop()!;if(depth>40||++count>100000)throw new ServiceError(400,"JSON_COMPLEXITY","JSON nesting or value count is excessive");if(item&&typeof item==="object")for(const child of Object.values(item))pending.push([child,depth+1]);}return value;
}
/** Bounded cursor pagination. IDs are stable; runtime tile keys are never business identifiers. */
export function pagination(url:URL):{cursor:string;limit:number}{const cursor=url.searchParams.get("cursor")??"";if(cursor&&!/^[a-zA-Z0-9_-]{1,80}$/.test(cursor))throw new ServiceError(400,"INVALID_CURSOR","Invalid cursor");const limit=Number(url.searchParams.get("limit")??50);if(!Number.isInteger(limit)||limit<1||limit>100)throw new ServiceError(400,"INVALID_LIMIT","Limit must be 1..100");return{cursor,limit};}

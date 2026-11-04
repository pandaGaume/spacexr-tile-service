import {Value} from "@sinclair/typebox/value";
import type {Static,TSchema} from "@sinclair/typebox";
/** Structured API error. Internal stack traces and credentials never enter HTTP responses. */
export class ServiceError extends Error {
 /** Store the HTTP status, stable machine code and safe public message. */
 public constructor(public readonly status:number,public readonly code:string,message:string,public readonly details?:unknown){super(message);}
}
/** Interpret a JSON schema without runtime code generation, compatible with Workers' no-eval environment. */
export function parseSchema<T extends TSchema>(schema:T,value:unknown):Static<T>{
 if(!Value.Check(schema,value))throw new ServiceError(400,"INVALID_INPUT","Request does not match its schema",[...Value.Errors(schema,value)].slice(0,12).map(error=>({path:error.path,message:error.message})));
 return value as Static<T>;
}
/** Require an unambiguous safe object-path segment. */
export function safeId(value:string):string{if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value))throw new ServiceError(400,"INVALID_ID","Invalid resource identifier");return value;}
/** Decode and validate a relative resource path, rejecting traversal and encoded separators. */
export function safePath(value:string):string{let decoded:string;try{decoded=decodeURIComponent(value);}catch{throw new ServiceError(400,"INVALID_PATH","Malformed resource path");}if(!decoded||decoded.split("/").some(part=>!part||part==="."||part===".."||!/^[a-zA-Z0-9_.-]+$/.test(part)))throw new ServiceError(400,"INVALID_PATH","Unsafe resource path");return decoded;}
/** Compute a lowercase SHA-256 hex digest using the standard Web Crypto API. */
export async function sha256(bytes:Uint8Array|string):Promise<string>{const input=typeof bytes==="string"?new TextEncoder().encode(bytes):bytes;const digest=await crypto.subtle.digest("SHA-256",input.slice().buffer);return[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,"0")).join("");}
/** JSON response with explicit content type and no implicit public caching. */
export function json(value:unknown,status=200,headers:HeadersInit={}):Response{return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers}});}

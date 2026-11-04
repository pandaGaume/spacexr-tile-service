import type {D1PreparedStatement,R2Bucket} from "@cloudflare/workers-types";
import {ServiceError,safeId,safePath,sha256,type IServiceContext,type ILayer,type IJob} from "@spacexr-service/shared";
const initialized=new WeakMap<object,Promise<void>>();
/** Enforce the database instance boundary before management operations. No public tile path calls this function. */
export async function ensureDatabase(context:IServiceContext):Promise<void>{
 const database=context.env.DB;let pending=initialized.get(database);
 if(!pending){pending=(async()=>{const id=context.config.service.id;await database.prepare("INSERT OR IGNORE INTO service_identity(singleton,instance_id) VALUES(1,?)").bind(id).run();const row=await database.prepare("SELECT instance_id FROM service_identity WHERE singleton=1").first<{instance_id:string}>();if(row?.instance_id!==id)throw new ServiceError(503,"INSTANCE_BINDING_MISMATCH","Database belongs to another instance");await database.prepare("INSERT OR IGNORE INTO tenants(id,storage_limit,object_limit,job_limit) VALUES(?,?,?,?)").bind(context.config.service.ownerTenant,context.config.quotas.tenantStorageBytes,context.config.quotas.layerObjects,context.config.quotas.activeJobs).run();})();initialized.set(database,pending);pending.catch(()=>initialized.delete(database));}
 await pending;
}
/** Parameterized metadata statement. Identifiers are fixed in source; request values are bound. */
export function sql(context:IServiceContext,statement:string,...values:unknown[]):D1PreparedStatement{return context.env.DB.prepare(statement).bind(...values);}
/** Read one typed row without inventing defaults for a missing entity. */
export async function first<T>(context:IServiceContext,statement:string,...values:unknown[]):Promise<T|undefined>{return(await sql(context,statement,...values).first<T>())??undefined;}
/** Read a bounded query result. Callers provide pagination limits. */
export async function all<T>(context:IServiceContext,statement:string,...values:unknown[]):Promise<T[]>{return(await sql(context,statement,...values).all<T>()).results;}
/** Immutable object namespace, independent of the public URL layout. */
export function objectPrefix(instanceId:string,tenantId:string,kind:string,id:string,revision?:string):string{return["instances",safeId(instanceId),"tenants",safeId(tenantId),safeId(kind),safeId(id),...revision?["revisions",safeId(revision)]:[]].join("/");}
/** Public pointer is an atomic R2 value; its target is an immutable revision. */
export interface IPublicPointer {instanceId:string;resourceId:string;revision:string;sequence:number;rootKey:string;tenantId:string;kind:"layer"|"dataset";}
/** Dedicated public namespace. A private object is never written here by accident. */
export function pointerKey(instanceId:string,kind:"layers"|"datasets",id:string):string{return["instances",safeId(instanceId),"catalog",kind,safeId(id)+".json"].join("/");}
/** Compare-and-swap an active pointer. A slow older build cannot replace a newer revision. */
export async function activatePointer(bucket:R2Bucket,key:string,pointer:IPublicPointer):Promise<boolean>{
 for(let attempt=0;attempt<12;attempt++){
  const current=await bucket.get(key);const old=current?await current.json<IPublicPointer>():undefined;
  if(old&&old.sequence>pointer.sequence)return false;
  if(old&&old.sequence===pointer.sequence){if(old.revision!==pointer.revision)throw new ServiceError(409,"PUBLICATION_CONFLICT","Revision sequence conflict");return true;}
  const written=await bucket.put(key,JSON.stringify(pointer),{onlyIf:current?{etagMatches:current.etag}:{etagDoesNotMatch:"*"},httpMetadata:{contentType:"application/json",cacheControl:"public, max-age=30"}});
  if(written)return true;
 }
 throw new ServiceError(409,"PUBLICATION_BUSY","Active publication changed concurrently; retry the job");
}
/** Write-once object upload with a trusted builder digest and idempotent replay. */
export async function putImmutable(bucket:R2Bucket,key:string,bytes:Uint8Array,contentType:string,hash?:string):Promise<void>{
 const digest=hash??await sha256(bytes);const existing=await bucket.head(key);
 if(existing){if(existing.customMetadata?.sha256!==digest)throw new ServiceError(409,"IMMUTABLE_OBJECT_CONFLICT","Published object bytes cannot be overwritten");return;}
 const written=await bucket.put(key,bytes.slice().buffer,{onlyIf:{etagDoesNotMatch:"*"},customMetadata:{sha256:digest},httpMetadata:{contentType,cacheControl:"public, max-age=31536000, immutable"}});
 if(!written){const concurrent=await bucket.head(key);if(concurrent?.customMetadata?.sha256!==digest)throw new ServiceError(409,"IMMUTABLE_OBJECT_CONFLICT","Concurrent object differs");}
}
/** Serve bytes with immutable public caching or private no-store, using the actual stored content type. */
export async function serveObject(bucket:R2Bucket,key:string,isPublic:boolean):Promise<Response>{
 const object=await bucket.get(key);if(!object)throw new ServiceError(404,"OBJECT_NOT_FOUND","Resource not found");
 const headers=new Headers({"content-type":object.httpMetadata?.contentType??"application/octet-stream","etag":object.httpEtag,"cache-control":isPublic?"public, max-age=31536000, immutable":"private, no-store","x-content-type-options":"nosniff"});if(isPublic)headers.set("access-control-allow-origin","*");return new Response(object.body as unknown as BodyInit,{headers});
}
/** Persist a small safe audit record alongside a management mutation. */
export function audit(context:IServiceContext,operation:string,id?:string):D1PreparedStatement{const principal=context.principal!;return sql(context,"INSERT INTO audit_log(id,tenant_id,subject,operation,resource_id,created_at) VALUES(?,?,?,?,?,?)",crypto.randomUUID(),principal.tenantId,principal.subject,operation,id??null,Date.now());}
/** Tenant-scoped layer lookup. An unauthorized identifier is indistinguishable from an unknown one. */
export async function getLayer(context:IServiceContext,id:string):Promise<ILayer>{
 const row=await first<Record<string,unknown>>(context,"SELECT * FROM layers WHERE id=? AND tenant_id=? AND deleted=0",safeId(id),context.principal!.tenantId);if(!row)throw new ServiceError(404,"LAYER_NOT_FOUND","Layer not found");return{id:String(row.id),tenantId:String(row.tenant_id),name:String(row.name),bodyId:row.body_id?String(row.body_id):undefined,frameId:row.frame_id?String(row.frame_id):undefined,visibility:row.visibility as ILayer["visibility"],status:row.status as ILayer["status"],version:Number(row.version),activeRevision:row.active_revision?String(row.active_revision):undefined,metadata:JSON.parse(String(row.metadata)) as Record<string,unknown>};
}
/** Persist a replayable job and its queue outbox record in one database batch. */
export async function createJob(context:IServiceContext,kind:IJob["kind"],resourceId:string,payload:Record<string,unknown>,extra:D1PreparedStatement[]=[],jobId?:string):Promise<string>{
 const id=jobId??crypto.randomUUID(),now=Date.now();await context.env.DB.batch([...extra,sql(context,"INSERT INTO jobs(id,tenant_id,kind,resource_id,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",id,context.principal!.tenantId,kind,resourceId,JSON.stringify(payload),now,now),sql(context,"INSERT INTO outbox(job_id) VALUES(?)",id),audit(context,"job.create",id)]);context.execution.waitUntil(flushOutbox(context).catch(()=>undefined));return id;
}
/** Queue delivery may repeat; the job lease, not a message, owns processing authority. */
export async function flushOutbox(context:IServiceContext):Promise<void>{if(!context.env.JOBS)return;const pending=await all<{job_id:string}>(context,"SELECT job_id FROM outbox WHERE sent_at IS NULL LIMIT 20");for(const item of pending){await context.env.JOBS.send({jobId:item.job_id,instanceId:context.config.service.id});await sql(context,"UPDATE outbox SET sent_at=? WHERE job_id=?",Date.now(),item.job_id).run();}}
/** Validate a relative resource path below an immutable publication root. */
export function revisionPath(rootKey:string,path:string):string{return rootKey+"/"+safePath(path);}

export * from "./jobs";

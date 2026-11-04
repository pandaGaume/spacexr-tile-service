import type {D1Database,R2Bucket,Queue} from "@cloudflare/workers-types";
import type {IServiceConfig,IBodyProfile,IPlacedAssetInput} from "./schemas";
/** Per-instance bindings. S3 signing credentials exist only in Worker secrets. */
export interface IBindings {
 /** Deployment metadata database. */ DB:D1Database;
 /** Immutable public objects served by a custom CDN domain. */ PUBLIC:R2Bucket;
 /** Private originals, staging and private revision objects. */ PRIVATE:R2Bucket;
 /** Asynchronous job identifiers; persisted outbox covers producer failures. */ JOBS?:Queue<{jobId:string;instanceId:string}>;
 /** Scoped bootstrap owner token, never stored in source. */ OWNER_TOKEN:string;
 /** Separate credential for internal build operations. */ BUILD_TOKEN:string;
 /** S3-compatible account endpoint; absent only in local development. */ R2_ENDPOINT?:string;
 /** Per-instance public bucket name. */ R2_PUBLIC_BUCKET?:string;
 /** Per-instance private bucket name. */ R2_PRIVATE_BUCKET?:string;
 /** Restricted S3 key used only to sign uploads. */ R2_ACCESS_KEY_ID?:string;
 /** Restricted S3 secret used only to sign uploads. */ R2_SECRET_ACCESS_KEY?:string;
 /** Public custom-domain origin for immutable objects. */ STATIC_BASE_URL?:string;
 /** Optional Cloudflare per-location rate limiter, namespaced by instance. */ API_LIMIT?:{limit(options:{key:string}):Promise<{success:boolean}>};
 /** Explicit local-only upload mode; production configuration refuses it. */ LOCAL_DEV?:string;
}
/** Minimal background-execution port accepted by the Worker and tests. */
export interface IExecutionContext {waitUntil(promise:Promise<unknown>):void;}
/** Authorized principal, isolated from resource identifiers. */
export interface IPrincipal {tenantId:string;subject:string;scopes:readonly string[];kind:"owner"|"token"|"builder";}
/** Renderer-neutral body reference descriptor. Physical shape stays in the celestial registry. */
export interface IBodyReference {id:string;name:string;profile:IBodyProfile;semiMajorAxisMetres:number;semiMinorAxisMetres:number;}
/** Body integration port, optional for engineering-only deployments. */
export interface IBodyRegistry {list():readonly IBodyReference[];get(id:string):IBodyReference;}
/** Immutable per-request service context. */
export interface IServiceContext {config:IServiceConfig;env:IBindings;execution:IExecutionContext;bodies?:IBodyRegistry;request:Request;url:URL;principal?:IPrincipal;extensions?:readonly IServiceExtension[];}
/** Server-managed placement identity and optimistic version. */
export interface IPlacedAsset extends IPlacedAssetInput {id:string;layerId:string;version:number;}
/** Draft layer record and revision pointer. */
export interface ILayer {id:string;tenantId:string;name:string;bodyId?:string;frameId?:string;visibility:"public"|"private";status:"draft"|"published";version:number;activeRevision?:string;metadata:Record<string,unknown>;}
/** Persistent external-processing job. */
export interface IJob {id:string;tenantId:string;kind:"asset-validate"|"layer-publish"|"dataset-ingest";status:"queued"|"running"|"succeeded"|"failed";resourceId:string;payload:Record<string,unknown>;leaseToken?:string;leaseUntil?:number;error?:string;}
/** Business extension operates through explicit policies, not tile-math branches. */
export interface IServiceExtension {id:string;validateLayer?(input:unknown):void;validatePlacement?(input:unknown):void;authorize?(principal:IPrincipal,operation:string,resource:unknown):boolean;}
/** One optional capability contributes routes to the common HTTP application. */
export interface ICapability {id:string;handle(context:IServiceContext,segments:readonly string[]):Promise<Response|undefined>;}

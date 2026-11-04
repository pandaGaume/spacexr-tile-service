import {json,parseSchema,ServiceConfigSchema,ServiceError,type IServiceConfig,type IServiceContext,type ICapability,type IBodyRegistry,type IBindings,type IExecutionContext,type IServiceExtension} from "@spacexr-service/shared";
import {authorize} from "./auth";
/** Compose only explicitly selected route capabilities. Disabled modules need not be imported by an entry point. */
export function createApplication(configuration:IServiceConfig,capabilities:readonly ICapability[],bodies?:IBodyRegistry,extensions:readonly IServiceExtension[]=[]){
 const config=parseSchema(ServiceConfigSchema,configuration);
 if(config.features.layerPublishing&&!config.features.tiles3d)throw new Error("Layer publishing requires 3D layers");
 if(config.extensions.some(id=>!extensions.some(extension=>extension.id===id)))throw new Error("A configured extension is not installed");
 const requests=new Map<string,{count:number;until:number}>();
 return{async fetch(request:Request,env:IBindings,execution:IExecutionContext):Promise<Response>{
  const url=new URL(request.url),requestId=crypto.randomUUID();const context:IServiceContext={config,env,execution,bodies,request,url,extensions};
  const origin=request.headers.get("origin"),allowed=origin===config.service.adminOrigin||origin===new URL(config.service.baseUrl).origin;
  try{
   if(origin&&request.headers.has("authorization")&&!allowed)throw new ServiceError(403,"ORIGIN_NOT_ALLOWED","Origin is not authorized");
   if(request.method==="OPTIONS"){if(!allowed)throw new ServiceError(403,"ORIGIN_NOT_ALLOWED","Origin is not authorized");return new Response(null,{status:204,headers:{"access-control-allow-origin":origin!,"access-control-allow-methods":"GET,POST,PATCH,PUT,DELETE,OPTIONS","access-control-allow-headers":"authorization,content-type,idempotency-key,x-job-lease","access-control-max-age":"600"}});}
   const identity=config.service.id+":"+(request.headers.get("cf-connecting-ip")??"local");
   if(env.API_LIMIT){const allowed=await env.API_LIMIT.limit({key:identity});if(!allowed.success)throw new ServiceError(429,"RATE_LIMITED","Request rate limit exceeded");}
   else if(env.LOCAL_DEV!=="true")throw new ServiceError(503,"RATE_LIMIT_BINDING_REQUIRED","Production rate-limit binding is missing");const now=Date.now();let window=requests.get(identity);if(!window&&requests.size>=10000)throw new ServiceError(429,"RATE_LIMITED","Local rate limiter is full");if(!window||window.until<=now){window={count:0,until:now+60000};requests.set(identity,window);}if(++window.count>config.quotas.requestsPerMinute)throw new ServiceError(429,"RATE_LIMITED","Request rate limit exceeded");if(requests.size>10000)for(const[key,value]of requests)if(value.until<now)requests.delete(key);
   if(url.pathname==="/health")return json({status:"ok",instanceId:config.service.id,features:config.features},200,{"access-control-allow-origin":"*"});
   const parts=url.pathname.split("/").filter(Boolean);if(parts[0]!=="v1")throw new ServiceError(404,"NOT_FOUND","Route not found");
   if(parts[1]==="bodies"&&request.method==="GET"&&bodies){if(parts.length===2)return json({items:bodies.list()},200,{"access-control-allow-origin":"*"});if(parts.length===3)return json(bodies.get(parts[2]!),200,{"access-control-allow-origin":"*"});}
   // Every capability owns its schema and authorization checks; public delivery does not acquire a DB principal.
   for(const capability of capabilities){const response=await capability.handle(context,parts.slice(1));if(response){const headers=new Headers(response.headers);headers.set("x-request-id",requestId);headers.set("x-content-type-options","nosniff");if(origin&&allowed)headers.set("access-control-allow-origin",origin);return new Response(response.body,{status:response.status,headers});}}
   if(parts[1]==="whoami"){const principal=await authorize(context,"read");return json({instanceId:config.service.id,tenantId:principal.tenantId,scopes:principal.scopes},200,origin&&allowed?{"access-control-allow-origin":origin}:{});}
   throw new ServiceError(404,"NOT_FOUND","Route not found");
  }catch(error){const known=error instanceof ServiceError;const quota=!known&&error instanceof Error&&/QUOTA/.test(error.message);return json({error:{code:known?error.code:quota?"QUOTA_EXCEEDED":"INTERNAL_ERROR",message:known?error.message:quota?"Configured quota exceeded":"Request failed",requestId,...known&&error.details?{details:error.details}:{}}},known?error.status:quota?429:500,origin&&allowed?{"access-control-allow-origin":origin}:{});}
 }};
}

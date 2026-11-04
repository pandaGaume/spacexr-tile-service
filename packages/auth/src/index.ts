import {ServiceError,sha256,type IPrincipal,type IServiceContext} from "@spacexr-service/shared";
import {ensureDatabase,first} from "@spacexr-service/storage";
function equalHash(left:string,right:string):boolean{let difference=left.length^right.length;for(let index=0;index<Math.max(left.length,right.length);index++)difference|=(left.charCodeAt(index)||0)^(right.charCodeAt(index)||0);return difference===0;}
/** Resolve scoped opaque API tokens. Builder credentials never authorize user management routes. */
export async function authorize(context:IServiceContext,scope:string):Promise<IPrincipal>{
 const header=context.request.headers.get("authorization");if(!header?.startsWith("Bearer "))throw new ServiceError(401,"AUTHENTICATION_REQUIRED","Bearer token required");const token=header.slice(7);if(token.length<16||token.length>512)throw new ServiceError(401,"INVALID_TOKEN","Invalid token");
 const hash=await sha256(context.config.service.id+":"+token);let principal:IPrincipal|undefined;
 if(context.env.BUILD_TOKEN&&equalHash(hash,await sha256(context.config.service.id+":"+context.env.BUILD_TOKEN)))principal={tenantId:"_builder",subject:"builder",scopes:["build"],kind:"builder"};
 else if(context.env.OWNER_TOKEN&&equalHash(hash,await sha256(context.config.service.id+":"+context.env.OWNER_TOKEN)))principal={tenantId:context.config.service.ownerTenant,subject:"owner",scopes:["read","write","publish","admin"],kind:"owner"};
 else{
  await ensureDatabase(context);
  const row=await first<{tenant_id:string;subject:string;scopes:string;expires_at:number}>(context,"SELECT tenant_id,subject,scopes,expires_at FROM api_tokens WHERE hash=?",hash);
  if(row&&row.expires_at>Date.now())principal={tenantId:row.tenant_id,subject:row.subject,scopes:JSON.parse(row.scopes) as string[],kind:"token"};
 }
 if(!principal)throw new ServiceError(401,"INVALID_TOKEN","Invalid or expired token");if(!principal.scopes.includes(scope))throw new ServiceError(403,"INSUFFICIENT_SCOPE","Token does not permit this operation");context.principal=principal;await ensureDatabase(context);return principal;
}

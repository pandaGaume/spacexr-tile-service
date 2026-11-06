import configuration from "../../../deployments/admin.local.json";
import { BodyRegistry } from "@spacexr-service/body-adapter";
import { layerCapability, tenantCapability } from "@spacexr-service/layer-service";
import type { IBindings, IExecutionContext, IServiceConfig } from "@spacexr-service/shared";
import { createApplication } from "./application";
import { adminCapability } from "./admin";

interface IAdminBindings extends IBindings {
    ASSETS?: { fetch(request: Request): Promise<Response> };
}
const application = createApplication(
    configuration as IServiceConfig,
    [adminCapability(), layerCapability(), tenantCapability()],
    new BodyRegistry(configuration.catalog.bodies as IServiceConfig["catalog"]["bodies"]),
);
/** Same-origin administration shell and authenticated API. No generation capability is installed. */
export default {
    async fetch(request: Request, env: IAdminBindings, execution: IExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/v1/") || url.pathname === "/health")
            return application.fetch(request, env, execution);
        if (env.LOCAL_DEV === "true" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
            return new Response("Local development only", { status: 503 });
        const response = env.ASSETS
            ? await env.ASSETS.fetch(request)
            : new Response("Admin assets are unavailable", { status: 404 });
        const headers = new Headers(response.headers);
        headers.set(
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        );
        headers.set("x-content-type-options", "nosniff");
        headers.set("referrer-policy", "no-referrer");
        headers.set("cache-control", "no-cache");
        return new Response(response.body, { status: response.status, headers });
    },
};

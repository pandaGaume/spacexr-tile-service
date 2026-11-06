import {
    json,
    parseSchema,
    ServiceConfigSchema,
    ServiceError,
    type IServiceConfig,
    type IServiceContext,
    type ICapability,
    type IBodyRegistry,
    type IBindings,
    type IExecutionContext,
    type IServiceExtension,
} from "@spacexr-service/shared";
import { authorize } from "./auth";

/** Compose selected route capabilities and apply common authentication-origin and response rules. */
export function createApplication(
    configuration: IServiceConfig,
    capabilities: readonly ICapability[],
    bodies?: IBodyRegistry,
    extensions: readonly IServiceExtension[] = [],
) {
    const config = parseSchema(ServiceConfigSchema, configuration);
    if (config.features.layerPublishing && !config.features.tiles3d)
        throw new Error("Layer publishing requires 3D layers");
    if (config.extensions.some((id) => !extensions.some((extension) => extension.id === id)))
        throw new Error("A configured extension is not installed");
    const requests = new Map<string, { count: number; until: number }>();
    return {
        async fetch(request: Request, env: IBindings, execution: IExecutionContext): Promise<Response> {
            const url = new URL(request.url),
                requestId = crypto.randomUUID();
            const context: IServiceContext = { config, env, execution, bodies, request, url, extensions };
            const origin = request.headers.get("origin");
            const allowed = origin === config.service.adminOrigin || origin === new URL(config.service.baseUrl).origin;
            // Management responses contain private tenant metadata, including one-time access tokens.
            const finish = (response: Response): Response => {
                const headers = new Headers(response.headers);
                headers.set("x-request-id", requestId);
                headers.set("x-content-type-options", "nosniff");
                if (!headers.has("cache-control")) headers.set("cache-control", "private, no-store");
                if (origin && allowed) headers.set("access-control-allow-origin", origin);
                if (origin) headers.append("vary", "Origin");
                return new Response(response.body, { status: response.status, headers });
            };
            try {
                if (origin && request.headers.has("authorization") && !allowed)
                    throw new ServiceError(403, "ORIGIN_NOT_ALLOWED", "Origin is not authorized");
                if (request.method === "OPTIONS") {
                    if (!allowed) throw new ServiceError(403, "ORIGIN_NOT_ALLOWED", "Origin is not authorized");
                    return finish(
                        new Response(null, {
                            status: 204,
                            headers: {
                                "access-control-allow-origin": origin!,
                                "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
                                "access-control-allow-headers":
                                    "authorization,content-type,idempotency-key,x-job-lease",
                                "access-control-max-age": "600",
                            },
                        }),
                    );
                }
                const identity = config.service.id + ":" + (request.headers.get("cf-connecting-ip") ?? "local");
                if (env.API_LIMIT) {
                    if (!(await env.API_LIMIT.limit({ key: identity })).success)
                        throw new ServiceError(429, "RATE_LIMITED", "Request rate limit exceeded");
                } else {
                    if (env.LOCAL_DEV !== "true")
                        throw new ServiceError(
                            503,
                            "RATE_LIMIT_BINDING_REQUIRED",
                            "Production rate-limit binding is missing",
                        );
                    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
                        throw new ServiceError(
                            503,
                            "LOCAL_MODE_ONLY",
                            "Local development mode requires a loopback host",
                        );
                    const now = Date.now();
                    for (const [key, value] of requests) if (value.until <= now) requests.delete(key);
                    let window = requests.get(identity);
                    if (!window) {
                        if (requests.size >= 10000)
                            throw new ServiceError(429, "RATE_LIMITED", "Local rate limiter is full");
                        window = { count: 0, until: now + 60000 };
                        requests.set(identity, window);
                    }
                    if (++window.count > config.quotas.requestsPerMinute)
                        throw new ServiceError(429, "RATE_LIMITED", "Request rate limit exceeded");
                }
                if (url.pathname === "/health" && request.method === "GET")
                    return finish(json({ status: "ok", instanceId: config.service.id, features: config.features }));
                const parts = url.pathname.split("/").filter(Boolean);
                if (parts[0] !== "v1") throw new ServiceError(404, "NOT_FOUND", "Route not found");
                if (parts[1] === "bodies" && request.method === "GET" && bodies) {
                    if (parts.length === 2) return finish(json({ items: bodies.list() }));
                    if (parts.length === 3) return finish(json(bodies.get(parts[2])));
                }
                for (const capability of capabilities) {
                    const response = await capability.handle(context, parts.slice(1));
                    if (response) return finish(response);
                }
                if (parts[1] === "whoami" && parts.length === 2 && request.method === "GET") {
                    const principal = await authorize(context, "read");
                    return finish(
                        json({
                            instanceId: config.service.id,
                            tenantId: principal.tenantId,
                            subject: principal.subject,
                            scopes: principal.scopes,
                        }),
                    );
                }
                throw new ServiceError(404, "NOT_FOUND", "Route not found");
            } catch (error) {
                const known = error instanceof ServiceError;
                const quota = !known && error instanceof Error && /QUOTA/.test(error.message);
                return finish(
                    json(
                        {
                            error: {
                                code: known ? error.code : quota ? "QUOTA_EXCEEDED" : "INTERNAL_ERROR",
                                message: known ? error.message : quota ? "Configured quota exceeded" : "Request failed",
                                requestId,
                                ...(known && error.details ? { details: error.details } : {}),
                            },
                        },
                        known ? error.status : quota ? 429 : 500,
                    ),
                );
            }
        },
    };
}

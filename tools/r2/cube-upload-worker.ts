type IUploadBucket = {
    put(key: string, value: ReadableStream<Uint8Array>, options: {
        httpMetadata: { contentType: string; cacheControl: string };
    }): Promise<unknown>;
};

type IEnv = { BUCKET: IUploadBucket; UPLOAD_TOKEN: string };

/** Temporary local endpoint for pushing generated files into the bound R2 bucket. */
export default {
    async fetch(request: Request, env: IEnv): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
        if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
        if (request.headers.get("authorization") !== `Bearer ${env.UPLOAD_TOKEN}`)
            return new Response("Unauthorized", { status: 401 });
        let key: string;
        try {
            key = decodeURIComponent(url.pathname.slice(1));
        } catch {
            return new Response("Invalid object path", { status: 400 });
        }
        if (key !== "cube/catalog.json" && !key.startsWith("cube/moon/") && !key.startsWith("cube/mars/"))
            return new Response("Object path is outside the publication namespace", { status: 400 });
        if (!request.body) return new Response("Missing object body", { status: 400 });
        await env.BUCKET.put(key, request.body, {
            httpMetadata: {
                contentType: request.headers.get("content-type") ?? "application/octet-stream",
                cacheControl: request.headers.get("cache-control") ?? "public, max-age=31536000, immutable",
            },
        });
        return new Response("uploaded", { status: 201 });
    },
};
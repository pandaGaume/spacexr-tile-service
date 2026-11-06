import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import type { IDatasetDraft, IDatasetDraftInput, IPage } from "@spacexr-service/shared";

const owner = "test-only-owner-credential",
    builder = "test-only-builder-credential";
let mf: Miniflare;
const declaration = (): IDatasetDraftInput => ({
    name: "LOLA Shackleton",
    bodyId: "moon",
    source: { url: "https://trek.nasa.gov/moon/", attribution: "NASA / LOLA", notes: "Unpublished declaration" },
    descriptor: {
        scheme: "spacexr-cube-equiangular/1",
        body: "Moon",
        frame: "MOON_ME",
        referenceRadii: [1737400, 1737400, 1737400],
        content: "elevation",
        encoding: "terrarium",
        tileSize: 256,
        minLOD: 0,
        maxLOD: 0,
        subtrees: [{ face: 5, lod: 0, x: 0, y: 0, maxLOD: 2 }],
        tiles: "https://tiles.example.org/moon/{face}/{z}/{x}/{y}.png",
    },
});
async function call(
    path: string,
    method = "GET",
    body?: unknown,
    token: string | null = owner,
    headers: Record<string, string> = {},
): Promise<Response> {
    return (await mf.dispatchFetch("http://127.0.0.1:8790" + path, {
        method,
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })) as unknown as Response;
}
async function create(input = declaration(), token = owner): Promise<IDatasetDraft> {
    const response = await call("/v1/datasets", "POST", input, token);
    expect(response.status).toBe(201);
    return (await response.json()) as IDatasetDraft;
}
async function issue(tenantId: string, scopes: string[]): Promise<string> {
    const response = await call("/v1/tokens", "POST", { tenantId, scopes, expiresInSeconds: 3600 });
    expect(response.status).toBe(201);
    return ((await response.json()) as { token: string }).token;
}

beforeAll(async () => {
    mf = new Miniflare({
        modules: true,
        scriptPath: "dist/api/main.js",
        compatibilityDate: "2026-07-01",
        d1Databases: { DB: "admin-integration" },
        r2Buckets: ["PUBLIC", "PRIVATE"],
        assets: {
            directory: "dist/admin",
            binding: "ASSETS",
            routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
        },
        bindings: { LOCAL_DEV: "true", OWNER_TOKEN: owner, BUILD_TOKEN: builder },
    });
    const db = await mf.getD1Database("DB");
    for (const path of ["migrations/0001_metadata.sql", "migrations/0002_admin.sql"])
        await db.exec((await readFile(path, "utf8")).replace(/\r?\n/g, " "));
});
afterAll(async () => {
    await mf?.dispose();
});

describe("administration API with real local D1 and R2", () => {
    it("serves the same-origin shell with a restrictive content policy", async () => {
        const response = await call("/", "GET", undefined, null);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("/app.js");
        expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
        expect(response.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    });
    it("rejects missing, invalid and builder credentials on management routes", async () => {
        for (const token of [null, "unknown-token-long-enough", builder])
            expect((await call("/v1/admin/overview", "GET", undefined, token)).status).toBe(
                token === builder ? 403 : 401,
            );
    });
    it("returns scoped identity and configuration without secrets, with no-store headers", async () => {
        const who = await call("/v1/whoami");
        expect(who.status).toBe(200);
        expect(await who.json()).toMatchObject({ tenantId: "owner", scopes: ["read", "write", "publish", "admin"] });
        const response = await call("/v1/admin/config");
        const text = await response.text();
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(response.headers.get("x-request-id")).toBeTruthy();
        expect(text).toContain('"generationEnabled":false');
        expect(text).not.toContain(owner);
        expect(text).not.toContain(builder);
    });
    it("does not allow a foreign browser origin to use bearer credentials", async () => {
        const response = await call("/v1/datasets", "GET", undefined, owner, { origin: "https://foreign.example" });
        expect(response.status).toBe(403);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        const valid = await call("/v1/datasets", "OPTIONS", undefined, null, { origin: "http://127.0.0.1:8790" });
        expect(valid.status).toBe(204);
        expect(valid.headers.get("vary")).toContain("Origin");
    });
    it("creates and edits a cube declaration while keeping it an unpublished draft", async () => {
        const dataset = await create();
        expect(dataset.status).toBe("draft");
        expect(dataset.version).toBe(1);
        expect(dataset.descriptor.referenceRadii).toEqual([1737400, 1737400, 1737400]);
        const response = await call(`/v1/datasets/${dataset.id}`, "PATCH", {
            ...declaration(),
            name: "LOLA revised",
            version: dataset.version,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ name: "LOLA revised", version: 2, status: "draft" });
        const db = await mf.getD1Database("DB");
        expect((await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())?.n).toBe(0);
        expect((await db.prepare("SELECT COUNT(*) AS n FROM datasets").first<{ n: number }>())?.n).toBe(0);
        const bucket = await mf.getR2Bucket("PUBLIC");
        expect((await bucket.list()).objects).toHaveLength(0);
    });
    it("preserves the newer draft on stale edits and deletions", async () => {
        const dataset = await create();
        const path = `/v1/datasets/${dataset.id}`;
        expect((await call(path, "PATCH", { ...declaration(), version: 1 })).status).toBe(200);
        expect((await call(path, "PATCH", { ...declaration(), name: "stale", version: 1 })).status).toBe(409);
        expect((await call(path, "DELETE", { version: 1 })).status).toBe(409);
        const current = (await (await call(path)).json()) as IDatasetDraft;
        expect(current.version).toBe(2);
        expect(current.name).not.toBe("stale");
        expect((await call(path, "DELETE", { version: 2 })).status).toBe(204);
        expect((await call(path)).status).toBe(404);
    });
    it("enforces body, encoding, level, template and source URL invariants", async () => {
        const invalid: IDatasetDraftInput[] = [];
        let value = declaration();
        value.descriptor.body = "Mars";
        invalid.push(value);
        value = declaration();
        value.descriptor.encoding = "jpeg";
        invalid.push(value);
        value = declaration();
        value.descriptor.referenceRadii[1] = 0;
        invalid.push(value);
        value = declaration();
        value.descriptor.subtrees[0].x = 1;
        invalid.push(value);
        value = declaration();
        value.descriptor.maxLOD = 25;
        invalid.push(value);
        value = declaration();
        value.descriptor.tiles = "https://tiles.example.org/{z}/{x}/{y}.png";
        invalid.push(value);
        value = declaration();
        value.source.url = "https://user:password@source.example/data";
        invalid.push(value);
        value = declaration();
        value.source.url = "https://source.example/data?token=secret";
        invalid.push(value);
        for (const input of invalid) expect((await call("/v1/datasets", "POST", input)).status).toBe(400);
    });
    it("isolates datasets, inventory and counters between tenants", async () => {
        const a = await issue("tenant-a", ["read", "write"]),
            b = await issue("tenant-b", ["read", "write"]);
        const dataset = await create(declaration(), a);
        expect((await call(`/v1/datasets/${dataset.id}`, "GET", undefined, b)).status).toBe(404);
        expect((await call(`/v1/datasets/${dataset.id}`, "PATCH", { ...declaration(), version: 1 }, b)).status).toBe(
            404,
        );
        expect((await call(`/v1/datasets/${dataset.id}`, "DELETE", { version: 1 }, b)).status).toBe(404);
        expect(await (await call("/v1/datasets", "GET", undefined, b)).json()).toMatchObject({ items: [] });
        expect(await (await call("/v1/admin/overview", "GET", undefined, b)).json()).toMatchObject({
            datasets: 0,
            layers: 0,
            assets: 0,
        });
    });
    it("lets read-only users inspect declarations but rejects modifications", async () => {
        const token = await issue("read-only", ["read"]);
        expect((await call("/v1/datasets", "GET", undefined, token)).status).toBe(200);
        expect((await call("/v1/datasets", "POST", declaration(), token)).status).toBe(403);
        expect((await call("/v1/tokens", "GET", undefined, token)).status).toBe(403);
    });
    it("paginates without repeating or skipping tenant records", async () => {
        const token = await issue("pagination", ["read", "write"]);
        for (let index = 0; index < 3; index++) await create({ ...declaration(), name: `Dataset ${index}` }, token);
        const first = (await (
            await call("/v1/datasets?limit=2", "GET", undefined, token)
        ).json()) as IPage<IDatasetDraft>;
        expect(first.items).toHaveLength(2);
        expect(first.cursor).toBeTruthy();
        const next = (await (
            await call(`/v1/datasets?limit=2&cursor=${first.cursor}`, "GET", undefined, token)
        ).json()) as IPage<IDatasetDraft>;
        expect(next.items).toHaveLength(1);
        expect(new Set([...first.items, ...next.items].map((item) => item.id)).size).toBe(3);
    });
    it("supports scoped layer CRUD with optimistic edits and disabled publication", async () => {
        const response = await call("/v1/layers", "POST", {
            name: "Shackleton assets",
            bodyId: "moon",
            visibility: "private",
        });
        expect(response.status).toBe(201);
        const layer = (await response.json()) as { id: string; version: number };
        expect(
            (await call(`/v1/layers/${layer.id}`, "PATCH", { name: "Shackleton", version: layer.version })).status,
        ).toBe(200);
        expect((await call(`/v1/layers/${layer.id}`, "PATCH", { name: "stale", version: layer.version })).status).toBe(
            409,
        );
        expect((await call(`/v1/layers/${layer.id}/publish`, "POST", { version: 2 })).status).toBe(404);
        expect((await call(`/v1/layers/${layer.id}`, "DELETE")).status).toBe(204);
        expect((await call(`/v1/layers/${layer.id}`)).status).toBe(404);
    });
    it("revokes an issued credential without returning its plaintext in the inventory", async () => {
        const token = await issue("revocation", ["read"]);
        const response = await call("/v1/tokens?limit=100");
        const text = await response.text();
        expect(text).not.toContain(token);
        const data = JSON.parse(text) as IPage<{ id: string; tenantId: string }>;
        const target = data.items.find((item) => item.tenantId === "revocation")!;
        expect((await call("/v1/whoami", "GET", undefined, token)).status).toBe(200);
        expect((await call(`/v1/tokens/${target.id}`, "DELETE")).status).toBe(204);
        expect((await call("/v1/whoami", "GET", undefined, token)).status).toBe(401);
    });
    it("rejects malformed JSON and unknown job filters without leaking a stack trace", async () => {
        const response = await mf.dispatchFetch("http://127.0.0.1:8790/v1/datasets", {
            method: "POST",
            headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
            body: "{",
        });
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain("stack");
        expect((await call("/v1/jobs?status=unknown")).status).toBe(400);
    });
    it("exposes tenant audit events and never treats a draft as a generation request", async () => {
        const response = await call("/v1/audit?limit=100");
        expect(response.status).toBe(200);
        const data = (await response.json()) as IPage<{ operation: string }>;
        expect(data.items.some((item) => item.operation === "dataset.create")).toBe(true);
        expect(await (await call("/v1/jobs")).json()).toMatchObject({ items: [] });
    });
});

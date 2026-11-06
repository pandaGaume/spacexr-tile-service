import { Type } from "@sinclair/typebox";
import { authorize } from "@spacexr-service/auth";
import { all, audit, first, sql } from "@spacexr-service/storage";
import {
    CubeDatasetDescriptorSchema,
    DatasetDraftInputSchema,
    DatasetDraftUpdateSchema,
    ServiceError,
    json,
    pagination,
    parseSchema,
    readJson,
    safeId,
    type ICapability,
    type ICubeDatasetDescriptor,
    type IDatasetDraft,
    type IDatasetDraftInput,
    type IServiceContext,
    type IPage,
} from "@spacexr-service/shared";

/** Validate public source URLs without ever fetching a user-controlled endpoint. */
function requireHttps(value: string): void {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new ServiceError(400, "INVALID_URL", "An absolute HTTPS URL is required");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw new ServiceError(400, "INVALID_URL", "Use HTTPS without credentials or a fragment");
    for (const key of url.searchParams.keys())
        if (/token|secret|password|signature|credential|api.?key/i.test(key))
            throw new ServiceError(400, "SECRET_IN_URL", "Store public source URLs without access credentials");
}
/** Validate the celestial contract without implementing client tiling mathematics in the service. */
export function validateCubeDescriptor(input: unknown): ICubeDatasetDescriptor {
    const descriptor = parseSchema(CubeDatasetDescriptorSchema, input);
    if (descriptor.minLOD > descriptor.maxLOD) throw new ServiceError(400, "INVALID_LEVELS", "minLOD exceeds maxLOD");
    const validEncoding = descriptor.content === "elevation" ? ["terrarium", "float32-le"] : ["png", "jpeg", "webp"];
    if (!validEncoding.includes(descriptor.encoding))
        throw new ServiceError(400, "INVALID_ENCODING", "Encoding does not match content");
    requireHttps(descriptor.tiles);
    for (const variable of ["face", "z", "x", "y"])
        if (!descriptor.tiles.includes(`{${variable}}`))
            throw new ServiceError(400, "INVALID_TEMPLATE", "Cube tile URL requires face, z, x and y variables");
    if (/\{(?!face\}|z\}|x\}|y\})/.test(descriptor.tiles))
        throw new ServiceError(400, "INVALID_TEMPLATE", "Unknown tile URL variable");
    const roots = new Set<string>();
    for (const root of descriptor.subtrees) {
        if (
            root.x >= 2 ** root.lod ||
            root.y >= 2 ** root.lod ||
            root.lod < descriptor.minLOD ||
            root.lod > descriptor.maxLOD + 1 ||
            root.maxLOD < root.lod ||
            root.maxLOD <= descriptor.maxLOD
        )
            throw new ServiceError(400, "INVALID_SUBTREE", "Subtree address or refinement levels are invalid");
        const key = `${root.face}/${root.lod}/${root.x}/${root.y}`;
        if (roots.has(key)) throw new ServiceError(400, "DUPLICATE_SUBTREE", "Subtree root is repeated");
        roots.add(key);
    }
    return descriptor;
}
function validateDraft(context: IServiceContext, input: IDatasetDraftInput): void {
    const body = context.bodies?.get(input.bodyId);
    if (!body) throw new ServiceError(400, "BODY_NOT_ENABLED", "Dataset body is not enabled");
    if (input.descriptor.body !== body.profile.catalogueName)
        throw new ServiceError(400, "BODY_MISMATCH", "Descriptor body does not match bodyId");
    requireHttps(input.source.url);
    validateCubeDescriptor(input.descriptor);
}
interface IDraftRow {
    id: string;
    name: string;
    body_id: string;
    descriptor: string;
    source: string;
    version: number;
    created_at: number;
    updated_at: number;
}
function draft(row: IDraftRow): IDatasetDraft {
    return {
        id: row.id,
        name: row.name,
        bodyId: row.body_id,
        descriptor: JSON.parse(row.descriptor) as ICubeDatasetDescriptor,
        source: JSON.parse(row.source) as IDatasetDraftInput["source"],
        version: row.version,
        status: "draft",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function page<T extends { id: string }>(rows: T[], limit: number): IPage<T> {
    return { items: rows.slice(0, limit), ...(rows.length > limit ? { cursor: rows[limit - 1].id } : {}) };
}
async function getDraft(context: IServiceContext, id: string): Promise<IDatasetDraft> {
    const row = await first<IDraftRow>(
        context,
        "SELECT * FROM dataset_drafts WHERE id=? AND tenant_id=?",
        safeId(id),
        context.principal!.tenantId,
    );
    if (!row) throw new ServiceError(404, "DATASET_NOT_FOUND", "Dataset draft not found");
    return draft(row);
}
/** Management routes for dataset declarations, configuration, inventory and task inspection. */
export function adminCapability(): ICapability {
    return {
        id: "admin",
        async handle(context, parts) {
            const method = context.request.method;
            if (parts[0] === "admin" && parts[1] === "config" && parts.length === 2 && method === "GET") {
                await authorize(context, "read");
                const config = context.config;
                return json({
                    instanceId: config.service.id,
                    name: config.service.name,
                    purpose: config.service.purpose,
                    features: config.features,
                    frames: config.catalog.engineeringFrames,
                    quotas: config.quotas,
                    generationEnabled: false,
                });
            }
            if (parts[0] === "admin" && parts[1] === "overview" && parts.length === 2 && method === "GET") {
                await authorize(context, "read");
                const tenant = context.principal!.tenantId;
                return json(
                    await first(
                        context,
                        `SELECT
        (SELECT COUNT(*) FROM dataset_drafts WHERE tenant_id=?) AS datasets,
        (SELECT COUNT(*) FROM layers WHERE tenant_id=? AND deleted=0) AS layers,
        (SELECT COUNT(*) FROM assets WHERE tenant_id=?) AS assets,
        (SELECT COUNT(*) FROM jobs WHERE tenant_id=? AND status='queued') AS queuedJobs,
        (SELECT COUNT(*) FROM jobs WHERE tenant_id=? AND status='running') AS runningJobs,
        (SELECT COALESCE(SUM(byte_length),0) FROM assets WHERE tenant_id=? AND status IN ('quarantined','validating','ready')) AS declaredAssetBytes`,
                        tenant,
                        tenant,
                        tenant,
                        tenant,
                        tenant,
                        tenant,
                    ),
                );
            }
            if (parts[0] === "datasets" && parts.length <= 2) {
                if (parts.length === 1 && method === "GET") {
                    await authorize(context, "read");
                    const { cursor, limit } = pagination(context.url);
                    const rows = await all<IDraftRow>(
                        context,
                        "SELECT * FROM dataset_drafts WHERE tenant_id=? AND id>? ORDER BY id LIMIT ?",
                        context.principal!.tenantId,
                        cursor,
                        limit + 1,
                    );
                    return json(page(rows.map(draft), limit));
                }
                if (parts.length === 1 && method === "POST") {
                    await authorize(context, "write");
                    const input = parseSchema(DatasetDraftInputSchema, await readJson(context.request));
                    validateDraft(context, input);
                    const id = crypto.randomUUID(),
                        now = Date.now();
                    await context.env.DB.batch([
                        sql(
                            context,
                            "INSERT INTO dataset_drafts(id,tenant_id,name,body_id,descriptor,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                            id,
                            context.principal!.tenantId,
                            input.name,
                            input.bodyId,
                            JSON.stringify(input.descriptor),
                            JSON.stringify(input.source),
                            now,
                            now,
                        ),
                        audit(context, "dataset.create", id),
                    ]);
                    return json(await getDraft(context, id), 201);
                }
                if (parts[1] && method === "GET") {
                    await authorize(context, "read");
                    return json(await getDraft(context, parts[1]));
                }
                if (parts[1] && method === "PATCH") {
                    await authorize(context, "write");
                    const { version, ...input } = parseSchema(
                        DatasetDraftUpdateSchema,
                        await readJson(context.request),
                    );
                    validateDraft(context, input);
                    await getDraft(context, parts[1]);
                    const results = await context.env.DB.batch([
                        sql(
                            context,
                            "UPDATE dataset_drafts SET name=?,body_id=?,descriptor=?,source=?,version=version+1,updated_at=? WHERE id=? AND tenant_id=? AND version=?",
                            input.name,
                            input.bodyId,
                            JSON.stringify(input.descriptor),
                            JSON.stringify(input.source),
                            Date.now(),
                            parts[1],
                            context.principal!.tenantId,
                            version,
                        ),
                        audit(context, "dataset.update", parts[1]),
                    ]);
                    if (!results[0].meta.changes)
                        throw new ServiceError(409, "VERSION_CONFLICT", "Draft changed; reload it before saving");
                    return json(await getDraft(context, parts[1]));
                }
                if (parts[1] && method === "DELETE") {
                    await authorize(context, "write");
                    const input = parseSchema(
                        Type.Object({ version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
                        await readJson(context.request),
                    );
                    await getDraft(context, parts[1]);
                    const results = await context.env.DB.batch([
                        sql(
                            context,
                            "DELETE FROM dataset_drafts WHERE id=? AND tenant_id=? AND version=?",
                            parts[1],
                            context.principal!.tenantId,
                            input.version,
                        ),
                        audit(context, "dataset.delete", parts[1]),
                    ]);
                    if (!results[0].meta.changes)
                        throw new ServiceError(409, "VERSION_CONFLICT", "Draft changed; reload it before deleting");
                    return new Response(null, { status: 204 });
                }
            }
            if (parts[0] === "jobs" && parts.length === 1 && method === "GET") {
                await authorize(context, "read");
                const { cursor, limit } = pagination(context.url),
                    status = context.url.searchParams.get("status");
                if (status && !["queued", "running", "succeeded", "failed"].includes(status))
                    throw new ServiceError(400, "INVALID_STATUS", "Unknown job status");
                const rows = await all<{ id: string }>(
                    context,
                    "SELECT id,kind,resource_id,status,error,created_at,updated_at FROM jobs WHERE tenant_id=? AND id>? AND (? IS NULL OR status=?) ORDER BY id LIMIT ?",
                    context.principal!.tenantId,
                    cursor,
                    status,
                    status,
                    limit + 1,
                );
                return json(page(rows, limit));
            }
            if (parts[0] === "assets" && parts.length === 1 && method === "GET") {
                await authorize(context, "read");
                const { cursor, limit } = pagination(context.url);
                return json(
                    page(
                        await all<{ id: string }>(
                            context,
                            "SELECT id,name,byte_length AS byteLength,content_type AS contentType,status,error,created_at AS createdAt FROM assets WHERE tenant_id=? AND id>? ORDER BY id LIMIT ?",
                            context.principal!.tenantId,
                            cursor,
                            limit + 1,
                        ),
                        limit,
                    ),
                );
            }
            if (parts[0] === "tokens" && method === "GET" && parts.length === 1) {
                await authorize(context, "admin");
                const { cursor, limit } = pagination(context.url);
                const rows = await all<{
                    id: string;
                    tenantId: string;
                    subject: string;
                    scopes: string;
                    expiresAt: number;
                }>(
                    context,
                    "SELECT hash AS id,tenant_id AS tenantId,subject,scopes,expires_at AS expiresAt FROM api_tokens WHERE hash>? ORDER BY hash LIMIT ?",
                    cursor,
                    limit + 1,
                );
                return json({
                    ...page(rows, limit),
                    items: rows.slice(0, limit).map((row) => ({ ...row, scopes: JSON.parse(row.scopes) as string[] })),
                });
            }
            if (parts[0] === "tokens" && method === "DELETE" && parts.length === 2) {
                await authorize(context, "admin");
                if (!/^[a-f0-9]{64}$/.test(parts[1]))
                    throw new ServiceError(400, "INVALID_ID", "Invalid token identifier");
                const results = await context.env.DB.batch([
                    sql(context, "DELETE FROM api_tokens WHERE hash=?", parts[1]),
                    audit(context, "token.revoke", parts[1]),
                ]);
                if (!results[0].meta.changes) throw new ServiceError(404, "TOKEN_NOT_FOUND", "Token not found");
                return new Response(null, { status: 204 });
            }
            return undefined;
        },
    };
}

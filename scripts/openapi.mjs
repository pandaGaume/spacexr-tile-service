import { readFile, writeFile } from "node:fs/promises";

/** Emit a standard OpenAPI 3.1 contract alongside the administration shell. */
export async function writeOpenApi() {
    const schemas = {};
    for (const name of [
        "ICubeDatasetDescriptor",
        "IDatasetDraftInput",
        "IDatasetDraftUpdate",
        "ILayerInput",
        "ILayerUpdate",
    ]) {
        schemas[name] = JSON.parse(await readFile(`schemas/${name}.schema.json`, "utf8"));
        delete schemas[name].$id;
    }
    const content = (schema) => ({ "application/json": { schema } });
    const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
    const version = {
        type: "object",
        required: ["version"],
        properties: { version: { type: "integer", minimum: 1 } },
        additionalProperties: false,
    };
    const idParameter = (name) => ({ name, in: "path", required: true, schema: { type: "string" } });
    const pagination = [
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
        { name: "cursor", in: "query", schema: { type: "string" } },
    ];
    const operation = (summary, scopes = ["read"], options = {}) => ({
        summary,
        security: scopes.length ? [{ bearerAuth: [] }] : [],
        "x-required-scopes": scopes,
        responses: {
            200: { description: "Successful response" },
            400: { description: "Invalid request" },
            401: { description: "Missing, invalid or expired bearer token" },
            403: { description: "Insufficient scope or unauthorized browser origin" },
            429: { description: "Configured quota or request limit exceeded" },
        },
        ...options,
    });
    const body = (name) => ({ required: true, content: content(ref(name)) });
    const draft = {
        type: "object",
        allOf: [
            ref("IDatasetDraftInput"),
            {
                type: "object",
                required: ["id", "status", "version", "createdAt", "updatedAt"],
                properties: {
                    id: { type: "string" },
                    status: { const: "draft" },
                    version: { type: "integer", minimum: 1 },
                    createdAt: { type: "integer", description: "Unix epoch milliseconds" },
                    updatedAt: { type: "integer", description: "Unix epoch milliseconds" },
                },
            },
        ],
    };
    // Do not use allOf with a closed input schema for extended responses: inline its properties.
    schemas.IDatasetDraft = {
        type: "object",
        required: [...schemas.IDatasetDraftInput.required, "id", "status", "version", "createdAt", "updatedAt"],
        properties: { ...schemas.IDatasetDraftInput.properties, ...draft.allOf[1].properties },
        additionalProperties: false,
    };
    const paths = {
        "/health": { get: operation("Service health and enabled capabilities", []) },
        "/v1/whoami": { get: operation("Resolve the current principal and scopes") },
        "/v1/bodies": { get: operation("List configured celestial catalogue references", []) },
        "/v1/admin/config": { get: operation("Read non-secret administration configuration") },
        "/v1/admin/overview": { get: operation("Read tenant-local inventory counts and declared asset bytes") },
        "/v1/datasets": {
            get: operation("List unpublished dataset drafts", ["read"], { parameters: pagination }),
            post: operation("Create a declaration without downloading or generating tiles", ["write"], {
                requestBody: body("IDatasetDraftInput"),
                responses: {
                    201: { description: "Draft created", content: content(ref("IDatasetDraft")) },
                    400: { description: "Invalid descriptor or source URL" },
                    401: { description: "Authentication required" },
                    403: { description: "Write scope required" },
                },
            }),
        },
        "/v1/datasets/{id}": {
            parameters: [idParameter("id")],
            get: operation("Read a tenant-owned draft", ["read"], {
                responses: {
                    200: { description: "Draft", content: content(ref("IDatasetDraft")) },
                    404: { description: "Unknown or foreign-tenant draft" },
                },
            }),
            patch: operation("Replace a draft using its current optimistic version", ["write"], {
                requestBody: body("IDatasetDraftUpdate"),
                responses: {
                    200: { description: "Updated draft", content: content(ref("IDatasetDraft")) },
                    409: { description: "Version conflict; reload the draft" },
                },
            }),
            delete: operation("Delete a draft using its current version", ["write"], {
                requestBody: { required: true, content: content(version) },
                responses: {
                    204: { description: "Deleted" },
                    409: { description: "Version conflict; reload the draft" },
                },
            }),
        },
        "/v1/layers": {
            get: operation("List tenant-owned 3D layers", ["read"], { parameters: pagination }),
            post: operation("Create a draft 3D layer", ["write"], {
                requestBody: body("ILayerInput"),
                responses: { 201: { description: "Layer created" } },
            }),
        },
        "/v1/layers/{id}": {
            parameters: [idParameter("id")],
            get: operation("Read a tenant-owned layer"),
            patch: operation("Edit a layer with its current version", ["write"], {
                requestBody: body("ILayerUpdate"),
                responses: { 200: { description: "Layer updated" }, 409: { description: "Version conflict" } },
            }),
            delete: operation("Soft-delete a layer", ["write"], {
                responses: { 204: { description: "Layer deleted" } },
            }),
        },
        "/v1/assets": {
            get: operation("List asset metadata without exposing private object keys", ["read"], {
                parameters: pagination,
            }),
        },
        "/v1/jobs": {
            get: operation("List existing tenant jobs; this endpoint creates no work", ["read"], {
                parameters: [
                    ...pagination,
                    { name: "status", in: "query", schema: { enum: ["queued", "running", "succeeded", "failed"] } },
                ],
            }),
        },
        "/v1/jobs/{id}": {
            parameters: [idParameter("id")],
            get: operation("Read a job without its private processing payload"),
        },
        "/v1/audit": { get: operation("List tenant audit events", ["read"], { parameters: pagination }) },
        "/v1/tokens": {
            get: operation("List issued token identifiers and permissions without plaintext values", ["admin"], {
                parameters: pagination,
            }),
            post: operation("Issue a tenant-scoped token; plaintext is returned only once", ["admin"], {
                requestBody: {
                    required: true,
                    content: content({
                        type: "object",
                        required: ["tenantId", "scopes", "expiresInSeconds"],
                        properties: {
                            tenantId: { type: "string" },
                            scopes: { type: "array", items: { enum: ["read", "write", "publish"] } },
                            expiresInSeconds: { type: "integer", minimum: 60, maximum: 31536000 },
                        },
                        additionalProperties: false,
                    }),
                },
                responses: { 201: { description: "Token created; cache-control is no-store" } },
            }),
        },
        "/v1/tokens/{tokenId}": {
            parameters: [idParameter("tokenId")],
            delete: operation("Revoke an issued token", ["admin"], {
                responses: { 204: { description: "Revoked" }, 404: { description: "Token not found" } },
            }),
        },
    };
    const contract = {
        openapi: "3.1.0",
        info: {
            title: "Celestial Tile Service Administration API",
            version: "0.1.0",
            description:
                "Tenant-scoped administration. Dataset declarations remain unpublished drafts. This local composition installs no tile-generation or publication capability. Bearer credentials must never be embedded in source URLs.",
        },
        servers: [{ url: "/" }],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: "http",
                    scheme: "bearer",
                    description: "Opaque token. Each operation documents its required scope.",
                },
            },
            schemas,
        },
        paths,
    };
    await writeFile("dist/admin/openapi.json", JSON.stringify(contract, null, 2) + "\n");
}

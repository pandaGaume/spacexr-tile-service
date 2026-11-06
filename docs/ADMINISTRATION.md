# Administration

The administration frontend and API run on the same origin. Dataset records are unpublished declarations: saving or editing them never downloads a source, generates a tile, creates an ingestion job or publishes coverage. The local application installs no tile generation or layer publication capability.

## Run locally

From the repository root, with dependencies installed and sibling libraries built:

```powershell
npm run generate
npm run admin:setup
npm run admin:dev
```

Open http://127.0.0.1:8790/. Setup builds the frontend and Worker, applies D1 migrations locally, and creates random owner and builder credentials in the ignored `.dev.vars` file if they are absent. It preserves existing credentials. Copy only the `OWNER_TOKEN` value from that file into the login form. Do not put this value in source control, a URL or a dataset descriptor.

The browser retains its credential only in memory. Reloading the page requires another login. The API validates the token for every request. Issued tokens are stored as instance-specific SHA-256 hashes with tenant, scopes and expiry. The owner can revoke individual issued tokens. Owner and builder secrets are configured outside the database; the builder secret cannot authorize administration requests.

The local Wrangler configuration uses its own local D1 and R2 bindings. It does not access the public R2 bucket used by the NASA demonstration. It contains placeholder identifiers for local resources, not deployable production resource IDs. Keep the existing development server bound to loopback. Local authentication requests fail when the local limiter is used with a non-loopback host.

After editing source files, run `npm run admin:build`. Wrangler observes the built Worker and assets; reload the frontend after a build.

## Frontend

- Overview: tenant-local counts, catalogue body references and declared asset volume.
- Datasets: create, read, edit and delete source and cube-descriptor drafts.
- 3D layers: create, read, rename, change visibility and soft-delete layer drafts.
- Assets: inspect existing declared asset metadata. File upload is disabled in this composition.
- Jobs: inspect existing processing jobs. No new work is enqueued by these views.
- Audit: browse tenant operations.
- API access: issue expiring tenant-scoped tokens and revoke them. This view requires owner administration scope; a new token's plaintext is shown only once.

Lists are cursor-paginated. Read-only principals can inspect data without edit controls. The UI renders catalogue values as text, not HTML. Same-origin resources and a restrictive content security policy avoid third-party scripts. Management responses carry `Cache-Control: no-store` and a diagnostic `X-Request-Id`.

## Dataset declarations

Each draft has a display name, enabled body ID, public source URL, attribution, notes and a `spacexr-cube-equiangular/1` descriptor. The descriptor names the catalogue body, dataset frame, optional explicit frame version, three reference radii in metres, content type, encoding, tile size, globally available levels, refined subtrees and URL template with face/z/x/y placeholders.

An elevation descriptor uses `terrarium` or `float32-le`. Heights are radial metres over its declared reference surface. Imagery uses `png`, `jpeg` or `webp`. `tileSize` counts cells; an elevation tile contains one additional point sample on each side. The descriptor is metadata only; this application does not implement the client cube geometry.

The dataset reference surface may differ from the catalogue ellipsoid. The lunar form initially suggests the LOLA sphere of radius 1,737,400 metres; this is an editable source-datum choice, not a conversion or a claim that every lunar source uses it. Frame, frame version, radii and source metadata must be checked for the selected product. Changing the selected body updates an untouched initial template, but does not overwrite manually edited JSON.

Validation rejects mismatched bodies, impossible subtree coordinates, inconsistent refinement levels, missing cube URL variables, incompatible content/encoding combinations, non-HTTPS URLs and credentials embedded in source URLs. Source URLs are saved without making server-side network requests.

Draft status is always `draft`. Target URL and availability fields express the intended dataset, not confirmed existing objects. They must not be advertised to a renderer until an explicit, verified publication process is implemented and enabled.

Updates require the current integer `version`; stale edits or deletions return HTTP 409. Reload and reconcile changes rather than overwriting another editor's work. Draft deletion is permanent metadata removal and never deletes remote source files or R2 objects. Layer deletion is a soft delete in the metadata database.

## API contract

The build emits an [OpenAPI 3.1 contract](http://127.0.0.1:8790/openapi.json), compatible with documentation and client-generation tools. TypeBox schemas also generate versioned JSON-schema and TypeScript declarations under `schemas/` and `packages/shared/generated/`.

| Route                          | Methods            | Required scope                  |
| ------------------------------ | ------------------ | ------------------------------- |
| `/health`                      | GET                | Public                          |
| `/v1/bodies`                   | GET                | Public                          |
| `/v1/whoami`                   | GET                | read                            |
| `/v1/admin/config`             | GET                | read                            |
| `/v1/admin/overview`           | GET                | read                            |
| `/v1/datasets`                 | GET, POST          | read, write respectively        |
| `/v1/datasets/{id}`            | GET, PATCH, DELETE | read, write, write respectively |
| `/v1/layers`                   | GET, POST          | read, write respectively        |
| `/v1/layers/{id}`              | GET, PATCH, DELETE | read, write, write respectively |
| `/v1/assets`                   | GET                | read                            |
| `/v1/jobs` and `/v1/jobs/{id}` | GET                | read                            |
| `/v1/audit`                    | GET                | read                            |
| `/v1/tokens`                   | GET, POST          | admin                           |
| `/v1/tokens/{tokenId}`         | DELETE             | admin                           |

Bearer credentials go in the `Authorization` header. Tenant resources return HTTP 404 when requested by another tenant. Inventory and overview counts use the current tenant; the owner token's issued-token inventory covers tenants administered by that owner. Source records, jobs and layers remain scoped to the principal's tenant.

List endpoints accept `limit` from 1 to 100 and return an opaque `cursor` when another page exists. Jobs additionally accept `status`: queued, running, succeeded or failed. Job inspection excludes processing payloads and lease secrets. Asset inspection excludes private object keys. Declared asset bytes are quota metadata, not measured live R2 storage usage.

## Verification

```powershell
npm run typecheck
npm test
```

The integration suite runs the built Worker against isolated Miniflare D1, R2 and static assets. It exercises authentication, scopes, cross-tenant access, optimistic versions, pagination, declaration validation, disabled publication, token revocation and security headers. Its test credentials and database are independent of `.dev.vars` and the local administration session.

## Production configuration

This checked-in composition is local only. Production requires explicit D1 and R2 resource IDs, applied migrations, secret bindings, instance origins, a Cloudflare rate-limit binding, and a production application configuration. No production deployment or Cloudflare resource creation is performed by local setup. The generation and publication switches stay disabled until the client tiling and processing pipeline are ready.

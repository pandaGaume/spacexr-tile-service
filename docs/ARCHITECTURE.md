# Universal geospatial tile publishing platform

## Deployment boundary

One source tree serves independently provisioned instances. Each deployment owns a Worker, D1 database, public and private R2 buckets or isolated namespaces, Queue, API-token configuration, catalogue, quotas and domains. No shared control-plane service is required. Service identity is immutable deployment configuration; tenant identity is a separate authorization scope within that instance.

Planetary, industrial, mining and railway configurations select capabilities and reference systems. Build-time composition generates a Worker entry with only the enabled route modules; runtime feature checks also refuse disabled operations. Extensions implement metadata validation, policies or processing without adding business-specific branches to tile addressing or 3D Tiles builders.

## Modules

| Module | Responsibility |
| --- | --- |
| shared | Authoritative JSON schemas, generated TypeScript contracts, structured errors and deployment configuration |
| body-adapter | celestial-core identity and shape, explicit body-fixed profiles, geodesy integration and engineering frames |
| tile2d-core | Geographic 2x1 matrix, manifests, independent imagery/DEM availability and deterministic fallback |
| tile2d-builder | Bounded offline pyramid generation, shared sample lattice, existing DEM codecs and lossless image adapter |
| storage | R2 object and D1 metadata ports, immutable revisions and active-pointer transactions |
| layer-service | Authorized asset/layer/object management, optimistic revisions and job creation |
| tiles3d-builder | Offline GLB composition, conservative geometric bounds, standard implicit availability and subtree generation using existing libraries |
| api | Cloudflare management routes and authorization, without heavy processing |
| admin | Minimal Pages UI using the same authenticated public API |
| build-consumer | Dispatch, retry and idempotent job orchestration; never GDAL inside an ordinary request |
| nasa-ingestion | Verified science-product metadata, GDAL pipelines and explicit provenance/datum handling |

## Spatial contracts

The canonical geographic raster matrix is equirectangular with north-west origin, [-180,180] longitude, [-90,90] latitude, 2 columns and 1 row at level zero. Level z has 2^(z+1) columns and 2^z rows. Two local quadtree roots reuse @spacexr/tiles operations. Longitude normalization never wraps latitude across a pole. Additional projected matrices declare their own extent and CRS; a global Web Mercator assumption is forbidden.

Imagery and DEM have independent footprints, zoom ranges and availability. Imagery is 256 or 512 square pixels. DEM uses a 257-square vertex lattice: neighbours share the same global sample coordinates. Float32 output declares little-endian metres and canonical NaN NoData. Terrarium output reuses @spacexr/dem and remains lossless image data. A quantized format must state its numerical error and cannot silently clip out-of-range planetary heights.

Body identity comes from celestial-core; physical radii are not copied into a parallel service database. Reference profiles add frame, latitude/longitude and datum semantics. Current runtime geometry is spherical or oblate. Unsupported triaxial/irregular geometry is an explicit capability error. Source raster CRS and vertical datum must be converted or preserved explicitly; areoid and ellipsoid heights are not interchangeable.

Engineering frames are first-class local Cartesian metre frames. A body-fixed anchor is required only when publishing into a body-fixed scene. Heading, pitch, roll, glTF Y-up conversion and the ENU basis are documented as explicit matrices, not inferred from a renderer.

## Tile publication and delivery

Builders write revision-scoped, content-hashed objects before a D1 transaction switches the active revision. Published objects are never overwritten. An interrupted job leaves an inactive staging revision; retry keys and content hashes make replay safe. Rollback changes only the active pointer.

Public URLs point directly to immutable R2/CDN objects. Tile requests do not query D1 or generate content. Management endpoints resolve catalogue and revision metadata. LOW/HD selection uses published availability, with a returned source address and ancestor UV window when falling back across zoom levels; redirecting a parent image without that mapping is incorrect.

Private bytes live outside the public custom-domain bucket. Every private resource path, including GLB, subtree, manifest and dependent asset, is authorized by the Worker. Private responses do not enter a shared public cache. Publication visibility is captured per revision and cannot expose content through a previously public storage path.

## Assets and 3D Tiles

Uploaded source assets are distinct from placed instances and deduplicated within an authorized storage boundary by content hash. Short-lived signed PUT URLs target a unique quarantine key. Finalization checks actual size, hash, GLB/glTF structure and resource references before the asset becomes usable. Credentials remain in server-side secrets. External resource references, decompression and extensions require explicit limits and supported decoders.

The offline builder resolves absolute or terrain-relative placements with declared datums. It computes ECEF/ENU through geodesy and preserves asset transforms. Static model bounds include node transforms and scale. Features that cannot be bounded correctly, such as unsupported deformation, are rejected explicitly rather than published with false bounds.

Implicit QUADTREE partitioning applies to placements that fit the chosen local XY cell. Large objects that cross child boundaries stay at an ancestor. ADD refinement preserves ancestor content when child content contains different objects. Sparse tile/content/child-subtree bits use the existing Morton/index functions and SubtreeCodec. A root body-fixed transform and Cartesian box volume avoid treating lunar coordinates as a WGS84 region. extras documents the body/reference profile and datum. Non-Earth clients must choose the matching EcefSpatialMetric; arbitrary third-party viewer compatibility is not promised.

## Asynchronous execution

Management operations create a persistent job and enqueue only identifiers. External Node/GDAL workers claim bounded jobs, process objects outside the request path, upload results, and complete a compare-and-swap publication. Queue delivery can repeat; a job lease and generation token prevent stale completion. HTTP pull consumers allow external processing without a permanently running Worker request.

Atomic job creation and enqueue use a D1 outbox so a Queue failure cannot lose a committed publish request. Queue retries and a reconciliation path drain the outbox. Immutable revision objects plus a metadata transaction provide publication atomicity without pretending R2 and D1 share a transaction.

## Security and operations

Scoped opaque API tokens are stored as hashes and bound to an instance, tenant and permitted operations. OIDC can implement the same principal port. Entity queries include tenant scope, mutations use validated schemas and optimistic versions, and management operations record an audit trail. Upload size, instance count, object count, build limits, concurrency and rate limits are configurable. Quotas are checked before work and reconciled against actual output.

Objects are bounded and processed incrementally. Costs include R2 object count, retained revisions, bytes, class-A writes, class-B reads, CDN hit rate, D1 queries, Queue traffic and external build CPU. A global scientific pyramid is not downloaded or regenerated by an HTTP tile request.

## Local and cloud configuration

Wrangler provides local D1/R2 and Worker execution. Local external builders use storage/metadata ports against the same API contract. Two deployment manifests must generate distinct resource names and can select different catalogues and capabilities from one source revision. Cloud resource identifiers and secrets are supplied at deployment time; the repository contains no fabricated account IDs or credentials.

Synthetic imagery and DEM validate coordinates, border samples, availability and fallback before any scientific ingestion. NASA candidate products are separate configurations, not published coverage. A source is publishable only after footprint, resolution, datum, redistribution metadata and successful generation are verified. GDAL and Docker execution are external prerequisites; neither a binary nor an active Docker daemon was available during the initial environment inspection.

## External contracts

- [3D Tiles 1.1](https://docs.ogc.org/cs/22-025r4/22-025r4.html) defines implicit subdivision, availability, subtree encoding and glTF content conventions.
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) require S3 signing; the Workers R2 binding does not generate them, and signed S3 URLs do not use a public custom domain.
- [Queues pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/) provide an external-worker transport.


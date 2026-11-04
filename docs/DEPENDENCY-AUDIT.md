# Dependency audit

## Inspected implementations

The source, manifests, tests and build configurations were inspected locally on 2026-11-04. Library names below are actual npm names, not inferred aliases.

| Repository | Package and inspected version | Reusable contracts | Boundary or missing capability | Service integration |
| --- | --- | --- | --- | --- |
| celestial-core | @spacexr/celestial-core 0.1.0, commit 86673b1 | SolarSystemBodies, ICelestialBodyDescriptor, RotationModel, catalogue ellipsoids, explicit Quantia quantities | No dataset registry, certified vertical datum registry, IAU frame identifiers, or triaxial shape implementation | Body adapter references catalogue identity and physical shape; separate reference profiles declare conventions and dataset datums without copying physical constants |
| geodesy_ts | @spacexr/geodesy 0.4.0 | Ellipsoid, GeodeticSystem.geodeticDegreesToEcef, inverse conversions, LocalTangentPlane, local basis, UTM, transverse Mercator, Lambert conic and Web Mercator | Oblate/spherical geometry only; no triaxial surface inversion or polar stereographic implementation | Reuse all geodetic/body-fixed/ENU operations; GDAL handles offline source projections. Reject unsupported geometry instead of substituting a sphere |
| 3d-tiles-core/node/packages/core | @spacexr/3d-tiles-core 0.1.0 | ITileset, ITile, ISubtree, SubtreeCodec.encodeBinary/decode, TilesetJsonCodec, validateTileset | No GLB ingestion/merging or complete scene publisher; validation is structural rather than a complete normative schema validator | Builder uses wire models, existing codecs and structural diagnostics, plus official schema validation |
| 3d-tiles-core/node/packages/runtime | @spacexr/3d-tiles-runtime 0.1.0, source at c0fdc478878815fc2e6901ae7c1f5172c60672ba | implicitMortonIndex, implicitAvailabilityIndex, StandardImplicitSubtreeLoader, LoadedSubtreeAvailability, TileRuntime, EcefSpatialMetric | Runtime is a consumer, not a GLB authoring engine; Earth is the default geodetic system | Use existing indexing and availability consumption in builder tests; configure EcefSpatialMetric with the selected body's GeodeticSystem |
| 3d-tiles-core/node/packages/tiles | @spacexr/tiles 0.1.0 | ITileAddress, parentTileAddress, childTileAddresses, ancestorTileAddress, URL and fetch ports | Address validators and quadkeys assume a 1x1 root; available metrics are Web Mercator | Adapt the two geographic hemispheric roots to existing local quadtree primitives. Add only the missing equirectangular 2x1 bounds and canonical longitude mapping |
| 3d-tiles-core/node/packages/raster | @spacexr/raster 0.1.0 | IRasterGrid, IRgbaImage, assertRasterSize, resampling/sampling and image decoder ports | Does not perform GDAL ingestion or R2 publication | Reuse raster data contracts; use an explicit server-side lossless image adapter |
| 3d-tiles-core/node/packages/dem | @spacexr/dem 0.1.0 | IHeightGrid, createHeightGrid, terrariumHeight, decodeHeightGrid, decodeDemTile, LocalDemDecoder, Mapzen preset and height statistics | Mapzen/Terrarium is a quantized RGB format, not a generic UInt16 scale/offset format. No raw Float32/UInt16 wire serializer in the inspected source | Reuse DEM grids and existing Terrarium decoder. Public terrariumPixel and encodeTerrariumGrid are implemented in this library on feat/dem-terrarium-encoder, not duplicated in the service |
| quantia | quantia 0.1.0 | Length, Angle, unit tags, explicit metre/radian conversions | It is a physical-units library, not a quantization or compression engine | Units at configuration and integration boundaries only; never substitute it for a DEM codec |

## Public DEM encoding

Terrarium uses h = R*256 + G + B/256 - 32768, in metres. The public DEM encoder rounds the complete 24-bit integer before splitting channels, so blue/green/red carries are correct. Quantization step is 1/256 metre; maximum rounding error is 1/512 metre. NaN becomes transparent NoData; valid minimum height remains opaque. Pixel encoding is independent of PNG compression.

The service can provide Float32 little-endian as its canonical lossless numerical grid and reuse Terrarium as an additional interoperability encoding. A UInt16 format requires its own declared offset/scale and reserved NoData code; it is not implied by the Mapzen name. Shared edges require a common sampling lattice and, for scaled integer formats, a consistent quantization convention.

## Dependency and packaging constraints

Celestial Core and Quantia are private local packages. Development uses sibling file references and built package entry points. The 3d-tiles source is a multi-package npm workspace under node/, not a root npm package. The source branch contains runtime capabilities that must not be assumed present in a registry tarball with the same version. Pin the source revision used by reproducible deployment builds and keep one dependency identity for Quantia and the shared SpaceXR packages.

Geodesy and the 3d-tiles packages declare Apache-2.0. Celestial Core declares Apache-2.0 and includes SunCalc notices. Quantia declares BUSL-1.1; its presence does not grant a different production license. The service must preserve the actual dependency licenses and must not claim every transitive dependency is Apache-2.0.

No Babylon dependency is required. Worker bundles must not import Node-only image processing, GDAL, GLB authoring or the traversal runtime. Capability-specific deployment entry points include only the enabled modules.

## Reference-frame gaps

Catalogue shape and dataset reference surface are separate facts. The Moon catalogue's current reference sphere and a product's declared lunar radius may differ; such a difference cannot be ignored when interpreting height. Mars MOLA areoid heights are not automatically ellipsoidal heights. Latitude can be planetocentric or planetographic. A service reference profile records conventions and a dataset declares its source/target datum. A missing datum conversion must reject a placement or publication that needs it, not quietly assume zero offset.

Geodesy supplies body-fixed Cartesian axes with X at latitude/longitude zero, Y at east longitude 90 degrees and Z north. RotationModel describes orientation in an astronomical frame; it does not establish a certified product-specific datum or frame epoch. Geographic raster ingestion therefore requires explicit CRS metadata and verified dataset conventions.

## Library contributions

Public Terrarium encoding belongs in @spacexr/dem and is implemented there. General-purpose 2x1 metrics could become an @spacexr/tiles feature; the service adapter must remain small and reuse its quadtree functions. Polar stereographic and triaxial geodesy, if needed as runtime mathematics, belong in geodesy rather than a duplicate service engine. Additional body reference metadata belongs in celestial-core when scientifically established; dataset inventories and processing state belong in the service.

## Verification boundaries

Library tests inspect codec round trips, implicit indexing, runtime loading, geodetic transforms and unit conventions. Service tests must additionally verify schema contracts, DEM border equality, immutable publication, private-resource authorization, tenant isolation and worker storage operations. Structural validateTileset success alone is not full 3D Tiles conformance. NASA coverage cannot be marked available without a validated source product and generated objects.


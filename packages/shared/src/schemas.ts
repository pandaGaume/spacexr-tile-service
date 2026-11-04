import {Type, type Static} from "@sinclair/typebox";
/** Stable URL-safe identifier; object-storage paths are never supplied directly by a browser. */
export const IdSchema=Type.String({pattern:"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$"});
const Text=Type.String({minLength:1,maxLength:200});
/** Canonical geographic extent in degrees. A wrapping footprint is represented by separate extents. */
export const ExtentSchema=Type.Tuple([Type.Number({minimum:-180,maximum:180}),Type.Number({minimum:-90,maximum:90}),Type.Number({minimum:-180,maximum:180}),Type.Number({minimum:-90,maximum:90})]);
const Level=Type.Integer({minimum:0,maximum:24});
/** Explicit sparse rectangular availability ranges, partitionable into immutable level shards. */
export const AvailabilityRangeSchema=Type.Object({z:Level,minX:Type.Integer({minimum:0}),maxX:Type.Integer({minimum:0}),minY:Type.Integer({minimum:0}),maxY:Type.Integer({minimum:0})},{additionalProperties:false});
/** Per-channel publication contract; a missing channel is absent, not inferred from another channel. */
export const TileChannelSchema=Type.Object({
 url:Text,minLevel:Level,maxLevel:Level,tileSize:Type.Union([Type.Literal(256),Type.Literal(512),Type.Literal(257)]),
 encoding:Type.Union([Type.Literal("webp"),Type.Literal("jpeg"),Type.Literal("float32-le"),Type.Literal("terrarium-png")]),
 unit:Type.Optional(Type.Literal("m")),noData:Type.Optional(Type.Union([Type.Literal("NaN"),Type.Literal("transparent")])),
 availability:Type.Array(AvailabilityRangeSchema,{maxItems:10000}),footprint:Type.Array(ExtentSchema,{minItems:1,maxItems:1000}),
 verticalDatum:Type.Optional(Text),quantizationStepMetres:Type.Optional(Type.Number({exclusiveMinimum:0})),resolutionMetres:Type.Number({exclusiveMinimum:0}),
},{additionalProperties:false});
/** Shared, versioned imagery/DEM manifest. Published revision paths are immutable. */
export const Tile2DManifestSchema=Type.Object({
 schema:Type.Literal("spacexr.tile2d/1"),id:IdSchema,bodyId:IdSchema,revision:IdSchema,instanceId:IdSchema,
 tileMatrixSet:Type.Object({id:Type.Literal("spacexr-geographic-2x1"),projection:Type.Literal("equirectangular"),origin:Type.Literal("north-west"),levelZeroColumns:Type.Literal(2),levelZeroRows:Type.Literal(1)},{additionalProperties:false}),
 referenceFrame:Text,latitudeType:Type.Literal("planetographic"),longitudeDirection:Type.Literal("east-positive"),
 imagery:Type.Optional(TileChannelSchema),elevation:Type.Optional(TileChannelSchema),
 fallbackDatasetIds:Type.Array(IdSchema,{maxItems:16}),priority:Type.Integer({minimum:0,maximum:10000}),
 provenance:Type.Object({kind:Type.Union([Type.Literal("synthetic"),Type.Literal("scientific"),Type.Literal("user")]),source:Text,attribution:Text,license:Text,verified:Type.Boolean()},{additionalProperties:false}),
 contentHashes:Type.Record(Type.String(),Type.String({pattern:"^[a-f0-9]{64}$"})),
 publishedAt:Type.String({minLength:10,maxLength:40}),
},{additionalProperties:false,$id:"ITile2DManifest"});
/** Physical shape comes from the celestial registry; this profile adds explicit reference conventions. */
export const BodyProfileSchema=Type.Object({id:IdSchema,catalogueName:Text,referenceFrame:Text,latitudeType:Type.Literal("planetographic"),longitudeDirection:Type.Literal("east-positive"),verticalDatum:Type.Literal("reference-ellipsoid")},{additionalProperties:false});
/** A local engineering frame has no implicit Earth origin or astronomical orientation. */
export const EngineeringFrameSchema=Type.Object({id:IdSchema,name:Text,units:Type.Literal("m"),axes:Type.Literal("right-handed-z-up")},{additionalProperties:false});
/** Independent deployment configuration; secrets and cloud resource identifiers are separate. */
export const ServiceConfigSchema=Type.Object({
 service:Type.Object({id:IdSchema,name:Text,purpose:Type.String({minLength:1,maxLength:80}),baseUrl:Text,adminOrigin:Text,ownerTenant:IdSchema},{additionalProperties:false}),
 features:Type.Object({tile2d:Type.Boolean(),tiles3d:Type.Boolean(),assetUpload:Type.Boolean(),layerPublishing:Type.Boolean()},{additionalProperties:false}),
 catalog:Type.Object({bodies:Type.Array(BodyProfileSchema,{maxItems:100}),engineeringFrames:Type.Array(EngineeringFrameSchema,{maxItems:100})},{additionalProperties:false}),
 quotas:Type.Object({assetBytes:Type.Integer({minimum:1024,maximum:67108864}),tenantStorageBytes:Type.Integer({minimum:1024}),layerObjects:Type.Integer({minimum:1,maximum:1000000}),activeJobs:Type.Integer({minimum:1,maximum:64}),requestsPerMinute:Type.Integer({minimum:1,maximum:100000}),builderObjects:Type.Integer({minimum:1,maximum:1000000})},{additionalProperties:false}),
 extensions:Type.Array(Type.String({pattern:"^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,100}$"}),{maxItems:20}),
},{additionalProperties:false,$id:"IServiceConfig"});
/** Draft layer in either a body-fixed or a local engineering reference system. */
export const LayerInputSchema=Type.Object({name:Text,visibility:Type.Union([Type.Literal("public"),Type.Literal("private")]),bodyId:Type.Optional(IdSchema),frameId:Type.Optional(IdSchema),metadata:Type.Optional(Type.Record(Type.String(),Type.Unknown()))},{additionalProperties:false,$id:"ILayerInput"});
/** Asset upload declaration; the original is quarantined until an external validator accepts it. */
export const UploadInputSchema=Type.Object({name:Text,byteLength:Type.Integer({minimum:20,maximum:67108864}),sha256:Type.String({pattern:"^[a-f0-9]{64}$"}),contentType:Type.Union([Type.Literal("model/gltf-binary"),Type.Literal("model/gltf+json")])},{additionalProperties:false,$id:"IUploadInput"});
const Geographic=Type.Object({longitude:Type.Number({minimum:-180,maximum:180}),latitude:Type.Number({minimum:-90,maximum:90}),altitude:Type.Number({minimum:-1000000,maximum:1e9}),altitudeMode:Type.Union([Type.Literal("absolute"),Type.Literal("relative-to-ground")])},{additionalProperties:false});
const Cartesian=Type.Object({x:Type.Number({minimum:-1e9,maximum:1e9}),y:Type.Number({minimum:-1e9,maximum:1e9}),z:Type.Number({minimum:-1e9,maximum:1e9})},{additionalProperties:false});
/** glTF -Z is forward, +Y is up. Heading is clockwise from north; pitch is nose-up and roll is right-down, in degrees. */
export const PlacedAssetInputSchema=Type.Object({assetId:IdSchema,position:Type.Union([Geographic,Cartesian]),orientation:Type.Object({heading:Type.Number(),pitch:Type.Number(),roll:Type.Number()},{additionalProperties:false}),scale:Type.Tuple([Type.Number({exclusiveMinimum:0,maximum:1e6}),Type.Number({exclusiveMinimum:0,maximum:1e6}),Type.Number({exclusiveMinimum:0,maximum:1e6})]),metadata:Type.Optional(Type.Record(Type.String(),Type.Unknown()))},{additionalProperties:false,$id:"IPlacedAssetInput"});
/** Conditional object edit; version is required to avoid lost updates. */
export const ObjectUpdateSchema=Type.Object({version:Type.Integer({minimum:1}),...PlacedAssetInputSchema.properties},{additionalProperties:false,$id:"IObjectUpdate"});
/** Conditional layer edit. Reference-system changes require a new layer. */
export const LayerUpdateSchema=Type.Object({version:Type.Integer({minimum:1}),name:Type.Optional(Text),visibility:Type.Optional(Type.Union([Type.Literal("public"),Type.Literal("private")]))},{additionalProperties:false,$id:"ILayerUpdate"});
/** Dataset registration refers to a separately validated immutable manifest. */
export const DatasetInputSchema=Type.Object({manifest:Tile2DManifestSchema},{additionalProperties:false,$id:"IDatasetInput"});
/** A publish request identifies the draft version being snapshotted. */
export const PublishInputSchema=Type.Object({version:Type.Integer({minimum:1})},{additionalProperties:false,$id:"IPublishInput"});
/** Authoritative deployment type inferred from the same runtime schema. */
export type IServiceConfig=Static<typeof ServiceConfigSchema>;
/** Authoritative versioned dataset type. */
export type ITile2DManifest=Static<typeof Tile2DManifestSchema>;
/** Independent body reference-profile metadata. */
export type IBodyProfile=Static<typeof BodyProfileSchema>;
/** Layer creation values. */ export type ILayerInput=Static<typeof LayerInputSchema>;
/** Placement values before a server assigns identity and version. */ export type IPlacedAssetInput=Static<typeof PlacedAssetInputSchema>;
/** Canonical channel availability values. */ export type IAvailabilityRange=Static<typeof AvailabilityRangeSchema>;
/** Published raster channel. */ export type ITileChannel=Static<typeof TileChannelSchema>;
/** Schemas emitted as JSON and generated declaration files for non-TypeBox consumers. */
export const publicSchemas={IServiceConfig:ServiceConfigSchema,ITile2DManifest:Tile2DManifestSchema,ILayerInput:LayerInputSchema,IUploadInput:UploadInputSchema,IPlacedAssetInput:PlacedAssetInputSchema,IObjectUpdate:ObjectUpdateSchema,ILayerUpdate:LayerUpdateSchema,IDatasetInput:DatasetInputSchema,IPublishInput:PublishInputSchema};

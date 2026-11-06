import { Type, type Static } from "@sinclair/typebox";
import { IdSchema } from "./schemas";

const Level = Type.Integer({ minimum: 0, maximum: 24 });
/** One fully available cube subtree, not a promise that an entire face is high resolution. */
export const CubeSubtreeSchema = Type.Object(
    {
        face: Type.Integer({ minimum: 0, maximum: 5 }),
        lod: Level,
        x: Type.Integer({ minimum: 0 }),
        y: Type.Integer({ minimum: 0 }),
        maxLOD: Level,
    },
    { additionalProperties: false },
);
/** Dataset declaration for the celestial tiling specification. Elevation heights are radial metres. */
export const CubeDatasetDescriptorSchema = Type.Object(
    {
        scheme: Type.Literal("spacexr-cube-equiangular/1"),
        body: Type.String({ minLength: 1, maxLength: 80 }),
        frame: Type.String({ minLength: 1, maxLength: 120 }),
        frameVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        referenceRadii: Type.Tuple([
            Type.Number({ exclusiveMinimum: 0, maximum: 1e12 }),
            Type.Number({ exclusiveMinimum: 0, maximum: 1e12 }),
            Type.Number({ exclusiveMinimum: 0, maximum: 1e12 }),
        ]),
        content: Type.Union([Type.Literal("elevation"), Type.Literal("imagery")]),
        encoding: Type.Union([
            Type.Literal("terrarium"),
            Type.Literal("float32-le"),
            Type.Literal("png"),
            Type.Literal("jpeg"),
            Type.Literal("webp"),
        ]),
        tileSize: Type.Union([Type.Literal(256), Type.Literal(512)]),
        minLOD: Level,
        maxLOD: Level,
        subtrees: Type.Array(CubeSubtreeSchema, { maxItems: 256 }),
        tiles: Type.String({ minLength: 1, maxLength: 2048 }),
    },
    { additionalProperties: false, $id: "ICubeDatasetDescriptor" },
);
/** Source provenance is a declaration. Saving it never downloads, verifies or publishes a dataset. */
export const DatasetDraftInputSchema = Type.Object(
    {
        name: Type.String({ minLength: 1, maxLength: 200 }),
        bodyId: IdSchema,
        source: Type.Object(
            {
                url: Type.String({ minLength: 1, maxLength: 2048 }),
                attribution: Type.String({ minLength: 1, maxLength: 1000 }),
                notes: Type.String({ maxLength: 4000 }),
            },
            { additionalProperties: false },
        ),
        descriptor: CubeDatasetDescriptorSchema,
    },
    { additionalProperties: false, $id: "IDatasetDraftInput" },
);
/** Conditional full replacement of a dataset draft, preventing accidental lost updates. */
export const DatasetDraftUpdateSchema = Type.Object(
    { version: Type.Integer({ minimum: 1 }), ...DatasetDraftInputSchema.properties },
    { additionalProperties: false, $id: "IDatasetDraftUpdate" },
);
/** Immutable shape of a cube dataset declaration. Availability does not imply generated objects exist. */
export type ICubeDatasetDescriptor = Static<typeof CubeDatasetDescriptorSchema>;
/** Editable source and target declaration for an unpublished dataset. */
export type IDatasetDraftInput = Static<typeof DatasetDraftInputSchema>;
/** Tenant-owned draft returned by the administration API. */
export interface IDatasetDraft extends IDatasetDraftInput {
    id: string;
    version: number;
    status: "draft";
    createdAt: number;
    updatedAt: number;
}
/** A bounded page. Pass cursor back unchanged to obtain the next page. */
export interface IPage<T> {
    items: T[];
    cursor?: string;
}
/** Read-only service information. This response deliberately contains no secret or token. */
export interface IAdminConfiguration {
    instanceId: string;
    name: string;
    purpose: string;
    features: Record<string, boolean>;
    frames: { id: string; name: string; units: string; axes: string }[];
    quotas: Record<string, number>;
    generationEnabled: false;
}
/** Tenant-local counts. Declared asset bytes are not measured R2 bucket usage. */
export interface IAdminOverview {
    datasets: number;
    layers: number;
    assets: number;
    queuedJobs: number;
    runningJobs: number;
    declaredAssetBytes: number;
}
/** Administration schemas available to generated JSON-schema and declaration consumers. */
export const adminSchemas = {
    ICubeDatasetDescriptor: CubeDatasetDescriptorSchema,
    IDatasetDraftInput: DatasetDraftInputSchema,
    IDatasetDraftUpdate: DatasetDraftUpdateSchema,
};

/** Generated from the shared JSON schema. Do not edit by hand. */

export interface ITile2DManifest {
  schema: "spacexr.tile2d/1";
  id: string;
  bodyId: string;
  revision: string;
  instanceId: string;
  tileMatrixSet: {
    id: "spacexr-geographic-2x1";
    projection: "equirectangular";
    origin: "north-west";
    levelZeroColumns: 2;
    levelZeroRows: 1;
  };
  referenceFrame: string;
  latitudeType: "planetographic";
  longitudeDirection: "east-positive";
  imagery?: {
    url: string;
    minLevel: number;
    maxLevel: number;
    tileSize: 256 | 512 | 257;
    encoding: "webp" | "jpeg" | "float32-le" | "terrarium-png";
    unit?: "m";
    noData?: "NaN" | "transparent";
    /**
     * @maxItems 10000
     */
    availability: {
      z: number;
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
    }[];
    /**
     * @minItems 1
     * @maxItems 1000
     */
    footprint: [[number, number, number, number], ...[number, number, number, number][]];
    verticalDatum?: string;
    quantizationStepMetres?: number;
    resolutionMetres: number;
  };
  elevation?: {
    url: string;
    minLevel: number;
    maxLevel: number;
    tileSize: 256 | 512 | 257;
    encoding: "webp" | "jpeg" | "float32-le" | "terrarium-png";
    unit?: "m";
    noData?: "NaN" | "transparent";
    /**
     * @maxItems 10000
     */
    availability: {
      z: number;
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
    }[];
    /**
     * @minItems 1
     * @maxItems 1000
     */
    footprint: [[number, number, number, number], ...[number, number, number, number][]];
    verticalDatum?: string;
    quantizationStepMetres?: number;
    resolutionMetres: number;
  };
  /**
   * @maxItems 16
   */
  fallbackDatasetIds:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  priority: number;
  provenance: {
    kind: "synthetic" | "scientific" | "visualization" | "user";
    source: string;
    attribution: string;
    license: string;
    verified: boolean;
  };
  contentHashes: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^(.*)$".
     */
    [k: string]: string;
  };
  publishedAt: string;
}

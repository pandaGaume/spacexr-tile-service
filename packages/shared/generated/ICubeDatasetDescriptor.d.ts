/** Generated from the shared JSON schema. Do not edit by hand. */

export interface ICubeDatasetDescriptor {
  scheme: "spacexr-cube-equiangular/1";
  body: string;
  frame: string;
  frameVersion?: string;
  /**
   * @minItems 3
   * @maxItems 3
   */
  referenceRadii: [number, number, number];
  content: "elevation" | "imagery";
  encoding: "terrarium" | "float32-le" | "png" | "jpeg" | "webp";
  tileSize: 256 | 512;
  minLOD: number;
  maxLOD: number;
  /**
   * @maxItems 256
   */
  subtrees: {
    face: number;
    lod: number;
    x: number;
    y: number;
    maxLOD: number;
  }[];
  tiles: string;
}

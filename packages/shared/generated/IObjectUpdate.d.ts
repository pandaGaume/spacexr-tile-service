/** Generated from the shared JSON schema. Do not edit by hand. */

export interface IObjectUpdate {
  version: number;
  assetId: string;
  position:
    | {
        longitude: number;
        latitude: number;
        altitude: number;
        altitudeMode: "absolute" | "relative-to-ground";
      }
    | {
        x: number;
        y: number;
        z: number;
      };
  orientation: {
    heading: number;
    pitch: number;
    roll: number;
  };
  /**
   * @minItems 3
   * @maxItems 3
   */
  scale: [number, number, number];
  metadata?: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^(.*)$".
     */
    [k: string]: unknown;
  };
}

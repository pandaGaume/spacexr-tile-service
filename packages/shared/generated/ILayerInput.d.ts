/** Generated from the shared JSON schema. Do not edit by hand. */

export interface ILayerInput {
  name: string;
  visibility: "public" | "private";
  bodyId?: string;
  frameId?: string;
  metadata?: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^(.*)$".
     */
    [k: string]: unknown;
  };
}

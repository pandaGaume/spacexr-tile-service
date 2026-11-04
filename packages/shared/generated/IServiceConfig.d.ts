/** Generated from the shared JSON schema. Do not edit by hand. */

export interface IServiceConfig {
  service: {
    id: string;
    name: string;
    purpose: string;
    baseUrl: string;
    adminOrigin: string;
    ownerTenant: string;
  };
  features: {
    tile2d: boolean;
    tiles3d: boolean;
    assetUpload: boolean;
    layerPublishing: boolean;
  };
  catalog: {
    /**
     * @maxItems 100
     */
    bodies: {
      id: string;
      catalogueName: string;
      referenceFrame: string;
      latitudeType: "planetographic";
      longitudeDirection: "east-positive";
      verticalDatum: "reference-ellipsoid";
    }[];
    /**
     * @maxItems 100
     */
    engineeringFrames: {
      id: string;
      name: string;
      units: "m";
      axes: "right-handed-z-up";
    }[];
  };
  quotas: {
    assetBytes: number;
    tenantStorageBytes: number;
    layerObjects: number;
    activeJobs: number;
    requestsPerMinute: number;
    builderObjects: number;
  };
  /**
   * @maxItems 20
   */
  extensions:
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
        string,
        string,
        string,
        string,
        string
      ];
}

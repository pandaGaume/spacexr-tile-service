import {SolarSystemBodies,type CelestialCatalogue} from "@spacexr/celestial-core/catalog";
import {GeodeticSystem,LocalTangentPlane} from "@spacexr/geodesy";
import {Length} from "quantia";
import {ServiceError,type IBodyProfile,type IBodyReference,type IBodyRegistry} from "@spacexr-service/shared";
/** Celestial-catalogue adapter. Defaults are referenced, never copied into a second physical database. */
export class BodyRegistry implements IBodyRegistry {
 private readonly bodies=new Map<string,IBodyReference>();
 /** Register selected profiles against an authoritative built-in or application-supplied celestial catalogue. */
 public constructor(profiles:readonly IBodyProfile[],private readonly catalogue:CelestialCatalogue=SolarSystemBodies){
  for(const profile of profiles){const body=Object.hasOwn(catalogue,profile.catalogueName)?catalogue[profile.catalogueName]:undefined;if(!body)throw new ServiceError(400,"UNKNOWN_BODY","Unknown celestial catalogue entry: "+profile.catalogueName);if(this.bodies.has(profile.id))throw new ServiceError(400,"DUPLICATE_BODY","Duplicate body reference profile");
   // Reading a Quantia quantity establishes the physical unit boundary; geometry remains geodesy's responsibility.
   body.meanRadius.getValue(Length.Units.m);
   this.bodies.set(profile.id,Object.freeze({id:profile.id,name:body.name,profile:Object.freeze({...profile}),semiMajorAxisMetres:body.ellipsoid.semiMajorAxis,semiMinorAxisMetres:body.ellipsoid.semiMinorAxis}));
  }
 }
 /** Selected body profiles in configuration order. */ public list():readonly IBodyReference[]{return[...this.bodies.values()];}
 /** Resolve an enabled body, or reject an unsupported reference. */ public get(id:string):IBodyReference{const body=this.bodies.get(id);if(!body)throw new ServiceError(404,"BODY_NOT_FOUND","Body is not enabled in this instance");return body;}
 /** Reference surface used for body-fixed Cartesian calculations. */ public system(id:string):GeodeticSystem{const body=this.get(id);return new GeodeticSystem(this.catalogue[body.profile.catalogueName]!.ellipsoid);}
 /** ENU tangent frame: east, north, up in metres at a geodetic degree anchor. */
 public tangent(id:string,latitudeDegrees:number,longitudeDegrees:number,heightMetres=0):LocalTangentPlane{return this.system(id).createLocalTangentPlaneDegrees(latitudeDegrees,longitudeDegrees,heightMetres);}
}

import { locationListRefOut } from "./location-fields";
/** Repository/compiler inputs; public Location reads use canonical envelopes. */
import definition from "./entity-definitions/04-location.entity";
import { z } from "zod";

export const rawLocationOutput = definition.readSchemas.output;
export const rawLocationList = definition.readSchemas.list;
export const rawLocationDetail = definition.readSchemas.detail;
export type RawLocationOutput = z.output<typeof rawLocationOutput>;
export type RawLocationDetail = z.output<typeof rawLocationDetail>;

/** Private scalar hierarchy rungs used to build picker projections. */
export const rawLocationPickerReference = locationListRefOut;
export type RawLocationPickerReference = z.output<
  typeof rawLocationPickerReference
>;

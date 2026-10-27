import definition from "./entity-definitions/19-planting.entity";
import { withEntityListMedia } from "./entity-media-raw-read";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawPlantingOut = definition.readSchemas.output;
export const rawPlantingListItemOut = withEntityListMedia(
  definition.readSchemas.list,
);
export type RawPlantingOut = z.output<typeof rawPlantingOut>;
export type RawPlantingListItemOut = z.output<typeof rawPlantingListItemOut>;

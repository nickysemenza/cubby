import { readSchemas as definitionSchemas } from "./entity-definitions/19-planting.entity";
import { withEntityListMedia } from "./entity-media-raw-read";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawPlantingOut = definitionSchemas.output;
export const rawPlantingListItemOut = withEntityListMedia(
  definitionSchemas.list,
);
export type RawPlantingOut = z.output<typeof rawPlantingOut>;
export type RawPlantingListItemOut = z.output<typeof rawPlantingListItemOut>;

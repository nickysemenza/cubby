import definition from "./entity-definitions/20-gardenEntry.entity";
import { withEntityListMedia } from "./entity-media-raw-read";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawGardenEntryOut = definition.readSchemas.output;
export const rawGardenEntryListItemOut = withEntityListMedia(
  definition.readSchemas.list,
);
export type RawGardenEntryOut = z.output<typeof rawGardenEntryOut>;
export type RawGardenEntryListItemOut = z.output<
  typeof rawGardenEntryListItemOut
>;

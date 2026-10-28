import { readSchemas as definitionSchemas } from "./entity-definitions/20-gardenEntry.entity";
import { withEntityListMedia } from "./entity-media-raw-read";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawGardenEntryOut = definitionSchemas.output;
export const rawGardenEntryListItemOut = withEntityListMedia(
  definitionSchemas.list,
);
export type RawGardenEntryOut = z.output<typeof rawGardenEntryOut>;
export type RawGardenEntryListItemOut = z.output<
  typeof rawGardenEntryListItemOut
>;

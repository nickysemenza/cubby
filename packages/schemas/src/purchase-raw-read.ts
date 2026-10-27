import definition from "./entity-definitions/12-purchase.entity";
import { withEntityListMedia } from "./entity-media-raw-read";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawPurchaseOut = definition.readSchemas.output;
export const rawPurchaseListItemOut = withEntityListMedia(
  definition.readSchemas.list,
);
export type RawPurchaseOut = z.output<typeof rawPurchaseOut>;
export type RawPurchaseListItemOut = z.output<typeof rawPurchaseListItemOut>;

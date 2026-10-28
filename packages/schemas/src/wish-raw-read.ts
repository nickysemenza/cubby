import { readSchemas as definitionSchemas } from "./entity-definitions/15-wish.entity";
import { withEntityListMedia } from "./entity-media-raw-read";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawWishOut = definitionSchemas.output;
export const rawWishListItemOut = withEntityListMedia(definitionSchemas.list);
export type RawWishOut = z.output<typeof rawWishOut>;
export type RawWishListItemOut = z.output<typeof rawWishListItemOut>;

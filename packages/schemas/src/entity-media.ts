import { z } from "zod";

import { entityRefSchema } from "./entity";
import { imageUrlSummary } from "./image-summary";

/**
 * Keep every local display-image request bounded by the same chunk size the
 * browser uses.  Entity refs are public shortcodes, so this applies at the
 * transport boundary as well as to normal UI callers. Batched id queries pair
 * it with es-toolkit's `chunk`; sort input first for stable cache keys.
 */
export const ID_CHUNK_SIZE = 50;

export const entityDisplayImagesInput = z.object({
  refs: z.array(entityRefSchema).max(ID_CHUNK_SIZE),
});
export type EntityDisplayImagesInput = z.infer<typeof entityDisplayImagesInput>;

/** Canonical public `entityKind:shortcode` key → cover or explicit no-image. */
export const entityDisplayImagesOutput = z.record(
  z.string(),
  imageUrlSummary.nullable(),
);
export type EntityDisplayImagesOutput = z.infer<
  typeof entityDisplayImagesOutput
>;

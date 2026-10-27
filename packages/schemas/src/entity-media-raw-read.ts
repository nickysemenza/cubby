import { z } from "zod";
/** Compiler-only media projections. Public responses use entity-read-media. */
import { imageOut } from "./entity-definitions/field-primitives";
import { createEntityReadMedia } from "./entity-read-media-factory";
const media: ReturnType<typeof createEntityReadMedia<typeof imageOut.shape>> =
  createEntityReadMedia(imageOut);
export const withEntityListMedia: typeof media.withEntityListMedia =
  media.withEntityListMedia;
export const withEntityDetailMedia: typeof media.withEntityDetailMedia =
  media.withEntityDetailMedia;

export type RawEntityAttachmentRead = z.infer<
  typeof media.entityAttachmentRead
>;

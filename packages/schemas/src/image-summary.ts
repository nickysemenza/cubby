import { z } from "zod";
import { imageShortcode } from "./identifiers";

export const imageUrlSummary = z.object({ url: z.url() });
export type ImageUrlSummary = z.infer<typeof imageUrlSummary>;

/**
 * One displayable image of a list row. `id` is the image's public shortcode
 * so a thumbnail can key and link it; `url` is the public R2 URL.
 */
export const displayImageSummary = z.object({
  id: imageShortcode,
  url: z.url(),
});
export type DisplayImageSummary = z.infer<typeof displayImageSummary>;

/**
 * The entity's displayable images in display order, resolved server-side by
 * one policy (`resolveEntityDisplayImages`): its own gallery/cover, or a
 * linked product's when `capabilities.images` is `"borrowed"`. Every
 * `displayImages` manifest entity's list row carries this; `[0]` is the cover.
 * Web and native thumbnails read it and derive nothing themselves.
 */
export const displayImagesField = z.array(displayImageSummary);

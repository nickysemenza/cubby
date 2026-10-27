import { computedFieldEnvelope, fieldValueOf } from "./field-envelope";
import { z } from "zod";

/** The ProductImage join's purpose, shared by attachment reads and edits. */
export const productImagePurpose = z.enum(["item", "label"]);

export const imageRepresentations = z.object({
  original: z.url(),
  transparent: z.url().nullable(),
  preferred: z.url(),
  preferredKind: z.enum(["original", "transparent"]),
});
export type ImageRepresentations = z.infer<typeof imageRepresentations>;
export const optionalImageRepresentations = imageRepresentations.optional();

export const imageUrlSummary = z.object({
  url: z.url(),
  representations: optionalImageRepresentations,
});
export type ImageUrlSummary = z.infer<typeof imageUrlSummary>;

export function preferredImageUrl(image: {
  url: string;
  representations?: ImageRepresentations;
}): string {
  return image.representations?.preferred ?? image.url;
}

/** Current Image values for public media consumers. */
export const publicImageUrlSummary = z.object({
  fields: z.object({
    url: computedFieldEnvelope(z.url()),
    representations: computedFieldEnvelope(imageRepresentations).optional(),
  }),
});
export type PublicImageUrlSummary = z.output<typeof publicImageUrlSummary>;

export function publicImageUrl(
  image: PublicImageUrlSummary,
): string | undefined {
  const representations = image.fields.representations;
  return (
    (representations ? fieldValueOf(representations)?.preferred : undefined) ??
    fieldValueOf(image.fields.url) ??
    undefined
  );
}

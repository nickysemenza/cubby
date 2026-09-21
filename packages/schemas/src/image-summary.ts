import { z } from "zod";

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

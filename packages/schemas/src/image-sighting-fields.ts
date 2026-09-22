import { z } from "zod";

/** Where a sighting's asset was found. */
export const imageSightingSourceType = z.enum([
  "userLibrary",
  "cloudShared",
  "iTunesSynced",
]);
export type ImageSightingSourceType = z.infer<typeof imageSightingSourceType>;

/** How the sighting was recorded: a fresh photo-import commit, or a later
 * library scan matching an existing Image by hash/aspect. */
export const imageSightingMatchKind = z.enum(["import", "libraryMatch"]);
export type ImageSightingMatchKind = z.infer<typeof imageSightingMatchKind>;

export const imageSightingLocation = z.object({
  lat: z.number(),
  lng: z.number(),
  altitude: z.number().optional(),
  horizontalAccuracy: z.number().optional(),
});
export type ImageSightingLocation = z.infer<typeof imageSightingLocation>;

export const imageSightingCamera = z.object({
  make: z.string().optional(),
  model: z.string().optional(),
  lens: z.string().optional(),
  software: z.string().optional(),
});
export type ImageSightingCamera = z.infer<typeof imageSightingCamera>;

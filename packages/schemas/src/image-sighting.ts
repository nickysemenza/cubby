import { z } from "zod";

import {
  deviceShortcode,
  imageShortcode,
  ledgerPartyShortcode,
} from "./identifier-fields";
import {
  imageSightingCamera,
  imageSightingLocation,
  imageSightingMatchKind,
  imageSightingSourceType,
} from "./image-sighting-fields";

export {
  imageSightingOut,
  type ImageSightingOut,
} from "./image-sighting-fields";
export type {
  ImageSightingCamera,
  ImageSightingLocation,
  ImageSightingMatchKind,
  ImageSightingSourceType,
} from "./image-sighting-fields";

const optionalText = z.string().trim().min(1).nullable().optional();

/**
 * The sighting fields a photo-import commit item or a library-metadata sync
 * reports about one asset — everything `ImageSighting` carries minus the
 * three identity columns (`imageId`/`ledgerPartyId`/`deviceId`, resolved by
 * the caller) and `matchKind` (set by the writer, never the reporter: an
 * import commit always writes `"import"`, a library scan always
 * `"libraryMatch"`).
 */
export const imageSightingReportFields = z.object({
  assetKey: z.string().trim().min(1),
  cloudIdentifier: optionalText,
  localIdentifier: optionalText,
  sourceType: imageSightingSourceType,
  mediaSubtypes: z.array(z.string()).default([]),
  originalFilename: optionalText,
  pixelWidth: z.number().int().positive().nullable().optional(),
  pixelHeight: z.number().int().positive().nullable().optional(),
  hasAdjustments: z.boolean().default(false),
  capturedAt: z.coerce.date().nullable().optional(),
  capturedAtOffsetMinutes: z.number().int().nullable().optional(),
  addedAt: z.coerce.date().nullable().optional(),
  location: imageSightingLocation.nullable().optional(),
  placeName: optionalText,
  camera: imageSightingCamera.nullable().optional(),
  hashDistance: z.number().int().nonnegative().nullable().optional(),
  aspectGate: z.boolean().nullable().optional(),
  observedAt: z.coerce.date(),
});
export type ImageSightingReportFields = z.infer<
  typeof imageSightingReportFields
>;

/** One sighting of one Image: a report plus who saw it and on which device. */
export const imageSightingRecordItem = imageSightingReportFields.extend({
  imageId: imageShortcode,
  /** Omitted: the acting login's linked member party. */
  ledgerPartyId: ledgerPartyShortcode.optional(),
  deviceId: deviceShortcode,
  matchKind: imageSightingMatchKind,
});
export type ImageSightingRecordItem = z.infer<typeof imageSightingRecordItem>;

/**
 * One transactional, replay-safe page of sightings for one or more images.
 * A repeat report of the same `(imageId, owner, assetKey)` replaces the
 * observation columns of the existing row instead of adding another.
 */
export const imageRecordSightingsInput = z.object({
  items: z.array(imageSightingRecordItem).min(1).max(100),
});

export const imageRecordSightingsOut = z.object({
  processed: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  /** One entry per input item, in order. */
  sightings: z.array(
    z.object({
      imageId: imageShortcode,
      assetKey: z.string(),
      created: z.boolean(),
    }),
  ),
});
export type ImageRecordSightingsOut = z.infer<typeof imageRecordSightingsOut>;

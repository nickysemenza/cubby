import { z } from "zod";

import { deviceShortcode, ledgerPartyShortcode } from "./identifier-fields";

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

/** A sighting as the Image detail reads it: owner and reporter are named. */
export const imageSightingOut = z.object({
  ledgerPartyId: ledgerPartyShortcode.nullable(),
  ownerName: z.string().nullable(),
  deviceId: deviceShortcode.nullable(),
  deviceName: z.string().nullable(),
  assetKey: z.string(),
  sourceType: imageSightingSourceType,
  mediaSubtypes: z.array(z.string()),
  originalFilename: z.string().nullable(),
  pixelWidth: z.number().int().nullable(),
  pixelHeight: z.number().int().nullable(),
  hasAdjustments: z.boolean(),
  capturedAt: z.date().nullable(),
  capturedAtOffsetMinutes: z.number().int().nullable(),
  addedAt: z.date().nullable(),
  location: imageSightingLocation.nullable(),
  placeName: z.string().nullable(),
  camera: imageSightingCamera.nullable(),
  matchKind: imageSightingMatchKind,
  hashDistance: z.number().int().nullable(),
  aspectGate: z.boolean().nullable(),
  observedAt: z.date(),
});
export type ImageSightingOut = z.infer<typeof imageSightingOut>;

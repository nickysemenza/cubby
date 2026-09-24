import { z } from "zod";

import { auditDateFilterFields } from "./base-entity";
import {
  generatedImageSightingFieldSchemas,
  generatedImageSightingFilterFields,
} from "./generated/entity-field-schemas.imageSighting.gen";
import { imageSightingShortcode } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";

export type {
  ImageSightingCamera,
  ImageSightingLocation,
  ImageSightingMatchKind,
  ImageSightingSourceType,
} from "./image-sighting-fields";

export const imageSightingCreateInput = z.object(
  generatedImageSightingFieldSchemas.create,
);
export type ImageSightingCreateInput = z.infer<typeof imageSightingCreateInput>;

/** One transactional retry unit for device-library metadata backfill. */
export const imageSightingBulkInput = z.object({
  items: z.array(imageSightingCreateInput).min(1).max(100),
});
export const imageSightingBulkOut = z.object({
  processed: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
});

export const imageSightingUpdateData = z.object(
  generatedImageSightingFieldSchemas.update,
);
export type ImageSightingUpdateData = z.infer<typeof imageSightingUpdateData>;

export const imageSightingUpdateInput = z.object({
  id: imageSightingShortcode,
  data: imageSightingUpdateData,
});

export const imageSightingOut = z.object(
  generatedImageSightingFieldSchemas.read,
);
export type ImageSightingOut = z.infer<typeof imageSightingOut>;

export const imageSightingListResponse =
  createPaginatedResponseSchema(imageSightingOut);

export const imageSightingFilterFields = {
  ...auditDateFilterFields,
  ...generatedImageSightingFilterFields,
};
export const imageSightingFilters = z.object(imageSightingFilterFields);
export type ImageSightingFilters = z.infer<typeof imageSightingFilters>;

/**
 * The sighting fields a photo-import commit item or a library-metadata sync
 * reports about one asset — everything `ImageSighting` carries minus the
 * three identity columns (`imageId`/`ledgerPartyId`/`deviceId`, resolved by
 * the caller) and `matchKind` (set by the writer, never the reporter: an
 * import commit always writes `"import"`, a library scan always
 * `"libraryMatch"`).
 */
export const imageSightingReportFields = z.object({
  assetKey: generatedImageSightingFieldSchemas.create.assetKey,
  cloudIdentifier: generatedImageSightingFieldSchemas.create.cloudIdentifier,
  localIdentifier: generatedImageSightingFieldSchemas.create.localIdentifier,
  sourceType: generatedImageSightingFieldSchemas.create.sourceType,
  mediaSubtypes: generatedImageSightingFieldSchemas.create.mediaSubtypes,
  originalFilename: generatedImageSightingFieldSchemas.create.originalFilename,
  pixelWidth: generatedImageSightingFieldSchemas.create.pixelWidth,
  pixelHeight: generatedImageSightingFieldSchemas.create.pixelHeight,
  hasAdjustments: generatedImageSightingFieldSchemas.create.hasAdjustments,
  capturedAt: generatedImageSightingFieldSchemas.create.capturedAt,
  capturedAtOffsetMinutes:
    generatedImageSightingFieldSchemas.create.capturedAtOffsetMinutes,
  addedAt: generatedImageSightingFieldSchemas.create.addedAt,
  location: generatedImageSightingFieldSchemas.create.location,
  placeName: generatedImageSightingFieldSchemas.create.placeName,
  camera: generatedImageSightingFieldSchemas.create.camera,
  hashDistance: generatedImageSightingFieldSchemas.create.hashDistance,
  aspectGate: generatedImageSightingFieldSchemas.create.aspectGate,
  observedAt: generatedImageSightingFieldSchemas.create.observedAt,
});
export type ImageSightingReportFields = z.infer<
  typeof imageSightingReportFields
>;

/** Internal candidate DTOs defer current Image facts to one public operation batch. */
import { z } from "zod";
import { rawImageOutput } from "./image-raw-read";
import {
  photoProductCandidate,
  photoProductEvidence,
  photoProductOwnPhoto,
} from "./photo-import-run";

export const rawPhotoProductOwnPhoto = rawImageOutput
  .pick({ id: true, url: true, representations: true })
  .extend({
    capturedAt: photoProductOwnPhoto.shape.capturedAt,
  });
export const rawOwnPhotoProductCandidate = photoProductCandidate.extend({
  ownPhotos: z.array(rawPhotoProductOwnPhoto).optional(),
});
export const rawOwnPhotoProductEvidence = photoProductEvidence.extend({
  ownPhotos: z.array(rawPhotoProductOwnPhoto).optional(),
});
export type RawOwnPhotoProductCandidate = z.output<
  typeof rawOwnPhotoProductCandidate
>;
export type RawOwnPhotoProductEvidence = z.output<
  typeof rawOwnPhotoProductEvidence
>;
export type RawPhotoProductOwnPhoto = z.output<typeof rawPhotoProductOwnPhoto>;

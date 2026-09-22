import { z } from "zod";

/** How confidently `Image.capturedByPartyId` reflects reality. */
export const imageCaptureAttribution = z.enum([
  "none",
  "derived",
  "ambiguous",
  "confirmed",
]);
export type ImageCaptureAttribution = z.infer<typeof imageCaptureAttribution>;

/** GPS coordinates carried by a sighting or EXIF read, copied onto the Image
 * as the derived capture location. Detail-only — never in list output. */
export const imageCaptureLocation = z.object({
  lat: z.number(),
  lng: z.number(),
  altitude: z.number().optional(),
  horizontalAccuracy: z.number().optional(),
});
export type ImageCaptureLocation = z.infer<typeof imageCaptureLocation>;

/**
 * What kind of evidence last set the derived capture fields, in the
 * precedence order `deriveImageCapture` enforces: manual > sighting >
 * import-url > exif > analysis > filename. `ruleId`/`detail` are free-text
 * breadcrumbs for the `imageCapture` field-explanation resolver — never
 * re-parsed for control flow.
 */
export const imageProvenanceEvidence = z.object({
  basis: z.enum([
    "manual",
    "sighting",
    "import-url",
    "exif",
    "analysis",
    "filename",
  ]),
  ruleId: z.string().optional(),
  detail: z.string().optional(),
});
export type ImageProvenanceEvidence = z.infer<typeof imageProvenanceEvidence>;

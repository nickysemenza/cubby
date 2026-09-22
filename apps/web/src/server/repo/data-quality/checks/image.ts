import { sql } from "drizzle-orm";

import { image } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Image = typeof image;

const isOwn = (t: Image) => sql`${t.source} = 'own'`;
const isOwnOrScreenshot = (t: Image) =>
  sql`${t.source} IN ('own', 'screenshot')`;

const hasLiveSighting = (t: Image) => sql`EXISTS (
  SELECT 1 FROM "ImageSighting" dq_sighting
  WHERE dq_sighting."imageId" = ${t.id} AND dq_sighting."deletedAt" IS NULL
)`;

export const imageChecks = defineEntityChecks({
  entity: "image",
  table: image,
  checks: {
    image_provenance_unknown: {
      missing: (t) => sql`${t.source} = 'unknown'`,
    },
    // Defect, not missing: an image is only expected to name a capturer once
    // it is household-sourced, and the gap is the derivation landing on a tie
    // (`captureAttribution = ambiguous`) rather than a blank value.
    image_capture_attribution: {
      expected: isOwn,
      missing: (t) => sql`${t.captureAttribution} = 'ambiguous'`,
    },
    // `own` and `screenshot` are the two sources with a genuine capture
    // moment; `catalog`/`unknown` never carry one.
    image_capture_date: {
      expected: isOwnOrScreenshot,
      missing: (t) => sql`${t.capturedAt} IS NULL`,
    },
    image_dimensions: {
      missing: (t) => sql`(${t.width} IS NULL OR ${t.height} IS NULL)`,
    },
    // `own` without any live sighting means the household-sourced claim has
    // no photo-library evidence behind it — a legacy upload never matched by
    // a library scan, or a sighting later deleted.
    image_sighting_missing: {
      expected: isOwn,
      missing: (t) => sql`NOT ${hasLiveSighting(t)}`,
    },
  },
});

import { sql } from "drizzle-orm";

import { location } from "~/server/db/schema";
import { displayableImageRawSql } from "~/server/repo/image-displayability";

import { defineEntityChecks } from "../registry";

type Location = typeof location;

const hasDisplayableImage = (t: Location) => sql`EXISTS (
  SELECT 1 FROM "EntityAttachment" dq_loc_img
  JOIN "Image" dq_loc_i ON dq_loc_i."id" = dq_loc_img."imageId" AND dq_loc_i."deletedAt" IS NULL
  WHERE dq_loc_img."subjectEntityId" = ${t.id} AND dq_loc_img."deletedAt" IS NULL
    AND ${sql.raw(displayableImageRawSql("dq_loc_i"))}
)`;

export const locationChecks = defineEntityChecks({
  entity: "location",
  table: location,
  checks: {
    location_ai_description: {
      // A description is only expected once there's a photo to describe.
      expected: hasDisplayableImage,
      missing: (t) =>
        sql`(${t.aiDescription} IS NULL OR trim(${t.aiDescription}) = '')`,
    },
    location_type: {
      missing: (t) => sql`${t.type} IS NULL`,
    },
  },
});

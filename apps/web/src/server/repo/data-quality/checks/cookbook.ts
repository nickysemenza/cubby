import { sql } from "drizzle-orm";

import { cookbook } from "~/server/db/schema";
import { displayableImageRawSql } from "~/server/repo/image-displayability";

import { defineEntityChecks } from "../registry";

type Cookbook = typeof cookbook;

// `findPartiallyImportedCookbooks` (repo/problems/detectors-cookbook.ts) uses
// this check's `gapCondition` as its own HAVING predicate rather than
// re-deriving it: sourceRecipeCount is the source EPUB's own recipe count, so
// more source recipes than live imported ones is a stalled or partial import.
const hasFewerLiveRecipesThanSource = (
  t: Cookbook,
) => sql`(${t.sourceRecipeCount} > (
  SELECT count(*)::int FROM "Recipe" dq_ckb_recipe
  WHERE dq_ckb_recipe."cookbookId" = ${t.id} AND dq_ckb_recipe."deletedAt" IS NULL
))`;

// The cover is the cookbook's one `cover` attachment (ADR 0006); a set but
// non-displayable image (e.g. a PDF) is the same as no cover.
const hasDisplayableCover = (t: Cookbook) => sql`EXISTS (
  SELECT 1 FROM "EntityAttachment" dq_ckb_att
  JOIN "Image" dq_ckb_img ON dq_ckb_img."id" = dq_ckb_att."imageId"
  WHERE dq_ckb_att."subjectEntityId" = ${t.id} AND dq_ckb_att."role" = 'cover'
    AND dq_ckb_att."deletedAt" IS NULL AND dq_ckb_img."deletedAt" IS NULL
    AND ${sql.raw(displayableImageRawSql("dq_ckb_img"))}
)`;

export const cookbookChecks = defineEntityChecks({
  entity: "cookbook",
  table: cookbook,
  checks: {
    cookbook_import_incomplete: {
      missing: hasFewerLiveRecipesThanSource,
    },
    cookbook_cover: {
      missing: (t) => sql`NOT ${hasDisplayableCover(t)}`,
    },
  },
});

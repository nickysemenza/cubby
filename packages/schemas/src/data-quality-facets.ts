import { z } from "zod";

/**
 * Facet names a manifest check may declare. Kept apart from `data-quality.ts`
 * so `entity-definitions/definition.ts` can validate a declaration without
 * importing the generated check registry that `data-quality.ts` re-exports.
 */
export const dataQualityFacetName = z.enum([
  "identity",
  "paperwork",
  "ledger",
  "settlement",
  "provenance",
  "integrity",
  "content",
  "linkage",
]);
export type DataQualityFacetName = z.infer<typeof dataQualityFacetName>;

export const dataQualityCheckKind = z.enum(["missing", "defect"]);
export type DataQualityCheckKind = z.infer<typeof dataQualityCheckKind>;

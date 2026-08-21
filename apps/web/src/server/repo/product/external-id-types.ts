import type { productExternalId } from "~/server/db/schema";

/** Accepts legacy/narrow relation fixtures while DB rows supply the new fields. */
export type MappableProductExternalId = Omit<
  typeof productExternalId.$inferSelect,
  "kind" | "isPrimary"
> & {
  kind?: typeof productExternalId.$inferSelect.kind;
  isPrimary?: typeof productExternalId.$inferSelect.isPrimary;
};

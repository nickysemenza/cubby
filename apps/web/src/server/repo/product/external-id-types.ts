import type { productExternalId } from "~/server/db/schema";

/** Accepts legacy/narrow relation fixtures while DB rows supply the new field. */
export type MappableProductExternalId = Omit<
  typeof productExternalId.$inferSelect,
  "kind"
> & {
  kind?: typeof productExternalId.$inferSelect.kind;
};

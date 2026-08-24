import type { productExternalId } from "~/server/db/schema";

export type MappableProductExternalId = Omit<
  typeof productExternalId.$inferSelect,
  "kind" | "isPrimary"
> & {
  kind?: typeof productExternalId.$inferSelect.kind;
  isPrimary?: typeof productExternalId.$inferSelect.isPrimary;
};

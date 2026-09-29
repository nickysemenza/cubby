import type { entityExternalId } from "~/server/db/schema";

export type MappableProductExternalId = Omit<
  typeof entityExternalId.$inferSelect,
  "kind" | "isPrimary"
> & {
  kind?: typeof entityExternalId.$inferSelect.kind;
  isPrimary?: typeof entityExternalId.$inferSelect.isPrimary;
};

import type { entityExternalId } from "~/server/db/schema";

export type MappableProductExternalId = Omit<
  typeof entityExternalId.$inferSelect,
  "isPrimary"
> & {
  isPrimary?: typeof entityExternalId.$inferSelect.isPrimary;
};

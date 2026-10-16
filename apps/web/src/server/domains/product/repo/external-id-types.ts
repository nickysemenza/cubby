import type { entityExternalId } from "~/server/db/external-identifier-tables";

export type MappableProductExternalId = Omit<
  typeof entityExternalId.$inferSelect,
  "isPrimary"
> & {
  isPrimary?: typeof entityExternalId.$inferSelect.isPrimary;
};

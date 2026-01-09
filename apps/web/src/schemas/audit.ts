import { z } from "zod";

/**
 * Audit log schemas and types.
 * Auditable entities include UI entities plus activity_type and activity_entry.
 */
export const auditEntitySchema = z.enum([
  "product",
  "location",
  "inventory",
  "recipe",
  "ingredient",
  "activity_type",
  "activity_entry",
]);
export type AuditEntityType = z.infer<typeof auditEntitySchema>;

import { z } from "zod";
import { entitySchema } from "./entity";

/**
 * Audit log schemas and types.
 * Auditable entities are a subset of all entities (excludes usda-food, image).
 */
export const auditEntitySchema = entitySchema.extract([
  "product",
  "location",
  "inventory",
  "recipe",
  "cookbook",
  "ingredient",
  "meal",
]);
export type AuditEntityType = z.infer<typeof auditEntitySchema>;

export const auditLogListInput = z.object({
  entityType: auditEntitySchema.optional(),
  entityId: z.uuid().optional(),
  limit: z.number().min(1).max(500).default(50),
  cursor: z.string().optional(),
});

export type AuditLogListInput = z.infer<typeof auditLogListInput>;

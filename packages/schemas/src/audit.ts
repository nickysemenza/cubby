import type { z } from "zod";
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
  "ingredient",
]);
export type AuditEntityType = z.infer<typeof auditEntitySchema>;

import { z } from "zod";
import { auditSourceSchema } from "./context";
import { entitySchema } from "./entity";
import { auditableEntities } from "./entity-manifest";
import { oneOrMany } from "./pagination";

/**
 * Audit log schemas and types.
 * Auditable entities are a subset of all entities (excludes usda-food, image) —
 * the set is the source-of-truth `auditableEntities` projection of the entity
 * manifest (kept in sync by entity-manifest.unit.test.ts).
 */
export const auditEntitySchema = entitySchema.extract([...auditableEntities]);
export type AuditEntityType = z.infer<typeof auditEntitySchema>;

export const auditLogListInput = z.object({
  entityType: auditEntitySchema.optional(),
  entityId: z.uuid().optional(),
  /**
   * `oneOrMany`: deliberately reuses `auditSourceSchema` rather than a
   * narrower enum — see that schema's doc comment for why `source` is
   * open-ended (the `script:<slug>` template-literal arm). Resolved with
   * `eqAny` in the repo.
   */
  source: oneOrMany(auditSourceSchema).optional(),
  // Same ISO-string encoding as `cursor` below (not `z.date()`): both are
  // plain strings over the wire, parsed to a `Date` in the repo.
  createdAtFrom: z
    .string()
    .optional()
    .describe("Inclusive lower bound on createdAt, as an ISO date string"),
  createdAtTo: z
    .string()
    .optional()
    .describe("Inclusive upper bound on createdAt, as an ISO date string"),
  limit: z.number().min(1).max(500).default(50),
  cursor: z.string().optional(),
});

export type AuditLogListInput = z.infer<typeof auditLogListInput>;

const auditLogActionSchema = z.enum(["create", "update", "delete"]);
const auditLogChangeSchema = z.object({
  from: z.unknown(),
  to: z.unknown(),
});

export const auditLogUserOut = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
  })
  .nullable();

export const auditLogEntryOut = z.object({
  id: z.uuid(),
  entityType: auditEntitySchema,
  entityId: z.uuid(),
  action: auditLogActionSchema,
  changes: z.record(z.string(), auditLogChangeSchema).nullable(),
  userId: z.string(),
  source: auditSourceSchema,
  createdAt: z.date(),
  user: auditLogUserOut,
});

export const auditLogListOut = z.object({
  entries: z.array(auditLogEntryOut),
  nextCursor: z.string().optional(),
});
export type AuditLogListOut = z.infer<typeof auditLogListOut>;

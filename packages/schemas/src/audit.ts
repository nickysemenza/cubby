import { z } from "zod";
import { auditChannelSchema } from "./context";
import { entitySchema } from "./entity";
import { auditableEntities, type ShortcodeEntity } from "./entity-manifest";
import {
  anyShortcodeSchema,
  deviceShortcode,
  runShortcode,
  nonEmptyTuple,
} from "./identifiers";
import { imageUrlSummary } from "./image-summary";
import { oneOrMany } from "./pagination";

/**
 * Audit log schemas and types.
 * Auditable entities are a subset of all entities (excludes usda-food, image) —
 * the set is the source-of-truth `auditableEntities` projection of the entity
 * manifest (kept in sync by entity-manifest.unit.test.ts).
 */
export const auditEntitySchema = entitySchema.extract([...auditableEntities]);
export type AuditEntityType = z.infer<typeof auditEntitySchema>;

const auditableEntityIdSchema = anyShortcodeSchema(
  nonEmptyTuple<ShortcodeEntity>(auditableEntities),
);

export const auditLogListInput = z.object({
  entityType: auditEntitySchema.optional(),
  entityId: auditableEntityIdSchema.optional(),
  channel: oneOrMany(auditChannelSchema).optional(),
  /** An OAuth client id (not a Cubby entity), e.g. the one Claude registered. */
  oauthClient: z.string().min(1).optional(),
  deviceId: deviceShortcode.optional(),
  /** Everything one Run wrote, e.g. an import or an agent session. */
  runId: runShortcode.optional(),
  // Date bounds stay ISO strings over the wire. `cursor` below is opaque (and
  // the repo continues accepting the former ISO cursor for compatibility).
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

/**
 * A `changes.from`/`changes.to` value, narrowed from `z.unknown()`.
 *
 * `AuditLog.changes` is jsonb populated by `computeChanges` diffing raw DB
 * columns (`repo/audit-log.ts`) — so by the time a value round-trips through
 * Postgres it is plain JSON: string/number/boolean/null, a jsonb object
 * (e.g. a recipe's `totals`), or an array (e.g. an unordered id-set diff).
 * `z.unknown()` made this boundary unintrospectable, which is exactly why a
 * raw uuid FK value (`vendorId`, `purchaseId`, ...) could reach an MCP payload
 * unnoticed — see `getAuditLog`'s shortcode remap, the fix this schema backs.
 * `from`/`to` are optional because `JSON.stringify` drops an `undefined`
 * property entirely on write, so a genuinely-undefined side of a diff comes
 * back as a missing key, not a present `null`.
 */
export type AuditJsonValue =
  | string
  | number
  | boolean
  | null
  | AuditJsonValue[]
  | { [key: string]: AuditJsonValue };

const auditJsonValueSchema: z.ZodType<AuditJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(auditJsonValueSchema),
    z.record(z.string(), auditJsonValueSchema),
  ]),
);

const auditLogChangeSchema = z.object({
  from: auditJsonValueSchema.optional(),
  to: auditJsonValueSchema.optional(),
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
  entryKey: z.string(),
  entityType: auditEntitySchema,
  entityId: auditableEntityIdSchema.nullable(),
  /**
   * The survivor's code when the audited entity was later merged away. The
   * entry keeps the identity that received the event (`entityId`); this is
   * a read-time projection (ADR 0006).
   */
  canonicalEntityId: auditableEntityIdSchema.nullable(),
  /**
   * The subject's human display name, resolved at read time (never stored on
   * the row, which only ever held ids). Null when the entity has no name-shaped
   * column at all — an inventory entry is identified by its product and
   * location, a purchase by its vendor and date — or when the referenced row is
   * gone. Distinct from `user.name`, which names the actor, not the subject.
   */
  entityName: z.string().nullable(),
  displayImage: imageUrlSummary.nullable(),
  action: auditLogActionSchema,
  changes: z.record(z.string(), auditLogChangeSchema).nullable(),
  userId: z.string(),
  channel: auditChannelSchema,
  /** The MCP OAuth client; its name is resolved at read time. */
  oauthClient: z
    .object({ id: z.string(), name: z.string().nullable() })
    .nullable(),
  device: z
    .object({ id: deviceShortcode, name: z.string().nullable() })
    .nullable(),
  runId: runShortcode.nullable(),
  createdAt: z.date(),
  user: auditLogUserOut,
});

export const auditLogListOut = z.object({
  entries: z.array(auditLogEntryOut),
  nextCursor: z.string().optional(),
});
export type AuditLogListOut = z.infer<typeof auditLogListOut>;

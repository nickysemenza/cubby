import {
  type AuditEntityKind,
  type AuditFieldChange,
  type AuditJsonValue,
  type AuditStoredChanges,
} from "@cubby/schemas/audit";
import { type ActorContext, type AuditChannel } from "@cubby/schemas/context";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { kernelApplyProvenance } from "~/server/db/kernel-apply-context";
import { auditLog } from "~/server/db/schema";
import { captureAuditId } from "~/server/generic/audit-log/repo/audit-receipts";
import { recordChange } from "~/server/generic/changes/repo/change";
import type { RemovalAuditEntry } from "~/server/generic/removal/repo/core";
import { jsonCursor } from "~/server/lib/json-cursor";

type AuditAction = "create" | "update" | "delete";
export const auditActionSchema = z.enum(["create", "update", "delete"]);

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
const auditChangeSchema = z.object({
  from: auditJsonValueSchema.optional(),
  to: auditJsonValueSchema.optional(),
});
export type AuditChanges = Record<string, z.output<typeof auditChangeSchema>>;
const auditChangesSchema: z.ZodType<AuditChanges> = z.record(
  z.string(),
  auditChangeSchema,
);
const auditSightingChangesSchema = z.object({
  sightings: z.record(z.string(), z.record(z.string(), auditChangeSchema)),
});

/**
 * Stored `AuditLog.changes` as flat field diffs. An `ImageSighting` event is
 * stored on its Image as `{ sightings: { <sighting id>: <field diffs> } }`
 * (sightings are not entities, so the Image is the audit subject); it reads
 * as `sightings.<field>` entries, or a lone `sighting` entry when the report
 * changed no tracked field, so the row still says what happened.
 */
export function readStoredChanges(stored: unknown) {
  const nested = auditSightingChangesSchema.safeParse(stored);
  if (!nested.success) return auditChangesSchema.parse(stored);
  const fields = Object.values(nested.data.sightings).flatMap((diff) =>
    Object.entries(diff).map(
      ([field, change]) => [`sightings.${field}`, change] as const,
    ),
  );
  return Object.fromEntries(
    fields.length > 0 ? fields : [["sighting", { to: "reported" }] as const],
  );
}

const auditCursor = jsonCursor(
  z.object({ createdAt: z.iso.datetime(), id: z.string().min(1) }),
  { prefix: "v1.", invalid: "Invalid audit log cursor" },
);

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

type AuditEntryFields = {
  entityKind: AuditEntityKind;
  entityId: string;
  changes?: AuditStoredChanges;
};

type AuditChange = { from: unknown; to: unknown };
export type AuditChangeMap = { [field: string]: AuditChange };

/** A create/update entry — anyone may write one; nothing cascades. */
type MutationAuditEntry = AuditEntryFields & {
  action: "create" | "update";
};

/**
 * A delete entry, and the proof that an embedding cascade ran with it.
 *
 * The removal-path invariant (root AGENTS.md) says every path that removes an
 * entity must soft-delete its `EntityEmbedding` rows in the same transaction.
 * That used to be a hand-copied line at 21 call sites, caught only after the
 * fact by `findOrphanedEntityEmbeddings` and a real-DB test. The witness moves
 * the check to compile time: `cascadeRemoval` is the only thing that can
 * produce this type, and it does the cascade before it produces one — so a
 * removal path that writes a delete entry without cascading no longer
 * typechecks.
 *
 * Runtime detection stays: types can't see out-of-band SQL, migrations, or a
 * removal that writes no audit row at all.
 */
export type AuditEntryInput = MutationAuditEntry | RemovalAuditEntry;

type AuditLogUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
} | null;

export type AuditLogRow = Omit<
  typeof auditLog.$inferSelect,
  "action" | "changes" | "channel"
> & {
  action: AuditAction;
  changes: AuditChanges | null;
  channel: AuditChannel;
  user: AuditLogUser;
  identity: {
    shortcode: string | null;
    canonical: { shortcode: string | null } | null;
  } | null;
  device: { shortcode: string; name: string } | null;
  run: { shortcode: string } | null;
};

type DecodedAuditCursor = {
  createdAt: Date;
  id: string;
};

/** Base64-pack the timestamp and private PK into one opaque cursor field. */
export function encodeAuditCursor(entry: {
  createdAt: Date;
  id: string;
}): string {
  return auditCursor.encode({
    createdAt: entry.createdAt.toISOString(),
    id: entry.id,
  });
}

export function decodeAuditCursor(cursor: string): DecodedAuditCursor {
  const payload = auditCursor.decode(cursor);
  return { createdAt: new Date(payload.createdAt), id: payload.id };
}

/**
 * Compute changes between before and after objects for specific fields.
 * Returns undefined if no changes detected.
 */
export function computeChanges<T extends object>(
  before: T,
  after: T,
  fields: (keyof T)[],
): AuditChangeMap | undefined {
  const changes: AuditChangeMap = {};

  for (const field of fields) {
    const fromVal = before[field];
    const toVal = after[field];

    // Deep compare for objects (like JSONB fields)
    const fromStr = JSON.stringify(fromVal);
    const toStr = JSON.stringify(toVal);

    if (fromStr !== toStr) {
      changes[String(field)] = { from: fromVal, to: toVal };
    }
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}

/**
 * Diff two id arrays where order doesn't matter — e.g. a `blockedByIds`
 * full-replacement set — unlike {@link computeChanges}' order-sensitive
 * (JSON.stringify) diff. Compares sorted copies so a mere reorder doesn't
 * register as a change; the returned `from`/`to` preserve the original
 * (unsorted) arrays. Returns `undefined` when the sets are equal.
 */
export function diffUnorderedIdSet<T extends string>(
  before: readonly T[],
  after: readonly T[],
): { from: T[]; to: T[] } | undefined {
  const beforeSorted = [...before].sort();
  const afterSorted = [...after].sort();
  if (JSON.stringify(beforeSorted) === JSON.stringify(afterSorted)) {
    return undefined;
  }
  return { from: [...before], to: [...after] };
}

/**
 * The column is typed as flat diffs so every reader must go through
 * {@link readStoredChanges}; the one nested shape (a sighting event on its
 * Image) is written here.
 */
const storedChanges = (
  changes: AuditStoredChanges | undefined,
): Record<string, AuditFieldChange> | undefined =>
  // SAFETY: jsonb stores either shape as-is; `readStoredChanges` reads both.
  changes as Record<string, AuditFieldChange> | undefined;

const auditActorColumns = (actor: ActorContext) => ({
  userId: actor.userId,
  channel: actor.channel,
  oauthClientId: actor.oauthClientId,
  deviceId: actor.deviceId,
  runId: actor.runId,
});

/**
 * Insert an audit log entry.
 */
export async function logAuditEntry(
  db: Database | DrizzleTransaction,
  actor: ActorContext,
  entry: AuditEntryInput,
): Promise<void> {
  const [inserted] = await unwrapDb(db)
    .insert(auditLog)
    .values({
      entityKind: entry.entityKind,
      entityId: entry.entityId,
      action: entry.action,
      changes: storedChanges(entry.changes),
      ...auditActorColumns(actor),
      provenance: kernelApplyProvenance(entry.entityKind, entry.entityId),
    })
    .returning({ id: auditLog.id });
  if (inserted) {
    captureAuditId(inserted.id);
    await recordChange(db, {
      kind: "source",
      categories: [entry.entityKind, "auditLog"],
    });
  }
}

const auditRecordKeys = [
  "entityKind",
  "entityId",
  "action",
  "changes",
  "userId",
  "channel",
  "oauthClientId",
  "deviceId",
  "runId",
  "provenance",
] as const satisfies readonly (keyof typeof auditLog.$inferInsert)[];
const auditRecordColumns = sql.join(
  auditRecordKeys.map((key) => sql.identifier(auditLog[key].name)),
  sql`, `,
);
const auditRecordTypes = sql.join(
  auditRecordKeys.map(
    (key) =>
      sql`${sql.identifier(auditLog[key].name)} ${sql.raw(auditLog[key].getSQLType())}`,
  ),
  sql`, `,
);

/**
 * Insert multiple audit log entries in a single batch operation.
 * Much more efficient than calling logAuditEntry in a loop (40x faster for 100 items).
 */
export async function logAuditEntries(
  db: Database | DrizzleTransaction,
  actor: ActorContext,
  entries: AuditEntryInput[],
): Promise<void> {
  if (entries.length === 0) return;

  // A kernel apply's rows carry its scope, version and inputs.
  const auditRecords = entries.map((entry) => ({
    entityKind: entry.entityKind,
    entityId: entry.entityId,
    action: entry.action,
    changes: storedChanges(entry.changes),
    ...auditActorColumns(actor),
    provenance: kernelApplyProvenance(entry.entityKind, entry.entityId),
  }));

  // One jsonb parameter however many rows: a layer's audit stays within the
  // per-statement bind budget.
  const inserted = await unwrapDb(db).execute<{
    id: string;
    entityKind: AuditEntityKind;
  }>(
    sql`INSERT INTO ${auditLog} (${auditRecordColumns})
      SELECT ${auditRecordColumns} FROM jsonb_to_recordset(${JSON.stringify(auditRecords)}::jsonb)
        AS record(${auditRecordTypes})
      RETURNING ${sql.identifier(auditLog.id.name)} AS id, ${sql.identifier(auditLog.entityKind.name)} AS "entityKind"`,
    "objects",
  );
  for (const row of inserted) captureAuditId(row.id);
  await recordChange(db, {
    kind: "source",
    categories: [...inserted.map((row) => row.entityKind), "auditLog"],
  });
}

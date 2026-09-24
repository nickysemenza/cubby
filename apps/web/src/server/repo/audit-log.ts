import type {
  AuditEntityType,
  AuditJsonValue,
  AuditLogListOut,
} from "@cubby/schemas/audit";
import {
  auditChannelSchema,
  type ActorContext,
  type AuditChannel,
} from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  entityManifest,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import {
  type DeviceId,
  type ImportRunId,
  parseEntityRef,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { oauthClient } from "~/server/db/auth.schema";
import { EDGE_KEY_TARGET_ENTITY } from "~/server/db/entity-incoming-edges";
import { auditLog } from "~/server/db/schema";
import { eqAny, unwrapDb } from "~/server/repo/database-helpers";
import { resolveEntityDisplayImages } from "~/server/repo/entity-display-image";
import { identityShortcodes } from "~/server/repo/entity-identity";
import type { RemovalAuditEntry } from "~/server/repo/removal/core";
import {
  type EntityRef,
  lookupEntityLabels,
} from "~/server/repo/shortcode-resolver";

type AuditAction = "create" | "update" | "delete";
const auditActionSchema = z.enum(["create", "update", "delete"]);

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
type AuditChanges = Record<string, z.output<typeof auditChangeSchema>>;
const auditChangesSchema: z.ZodType<AuditChanges> = z.record(
  z.string(),
  auditChangeSchema,
);
const auditCursorPayloadSchema = z.object({
  createdAt: z.string(),
  id: z.string().min(1),
});

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

type AuditEntryFields = {
  entityType: AuditEntityType;
  entityId: string;
  changes?: AuditChangeMap;
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

type AuditLogRow = Omit<
  typeof auditLog.$inferSelect,
  "action" | "changes" | "channel"
> & {
  action: AuditAction;
  changes: AuditChanges | null;
  channel: AuditChannel;
  user: AuditLogUser;
  device: { shortcode: string; name: string } | null;
  run: { shortcode: string } | null;
};

const AUDIT_CURSOR_PREFIX = "v1.";

type DecodedAuditCursor = {
  createdAt: Date;
  id?: string;
};

/** Base64-pack the timestamp and private PK into one opaque cursor field. */
export function encodeAuditCursor(entry: {
  createdAt: Date;
  id: string;
}): string {
  const payload = JSON.stringify({
    createdAt: entry.createdAt.toISOString(),
    id: entry.id,
  });
  return `${AUDIT_CURSOR_PREFIX}${btoa(payload)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`;
}

/** Decode v1 cursors while retaining the former ISO timestamp wire format. */
export function decodeAuditCursor(cursor: string): DecodedAuditCursor {
  if (!cursor.startsWith(AUDIT_CURSOR_PREFIX)) {
    const createdAt = new Date(cursor);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error("Invalid audit log cursor");
    }
    return { createdAt };
  }

  try {
    const encoded = cursor.slice(AUDIT_CURSOR_PREFIX.length);
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const payload = auditCursorPayloadSchema.parse(JSON.parse(atob(padded)));
    const createdAt = new Date(payload.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error("Malformed audit log cursor");
    }
    return { createdAt, id: payload.id };
  } catch {
    throw new Error("Invalid audit log cursor");
  }
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
  await unwrapDb(db)
    .insert(auditLog)
    .values({
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      changes: entry.changes,
      ...auditActorColumns(actor),
    });
}

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

  const auditRecords = entries.map((entry) => ({
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    changes: entry.changes,
    ...auditActorColumns(actor),
  }));

  await unwrapDb(db).insert(auditLog).values(auditRecords);
}

/**
 * Every FK-shaped ref (target entity + raw uuid value) named inside a single
 * entry's `changes` diff — both the `from` and `to` side of each field that
 * `EDGE_KEY_TARGET_ENTITY` recognizes as a foreign key. Feeds the same batched
 * `lookupShortcodes` round-trip as the entry's own `entityId`, so a raw uuid
 * inside `changes` (e.g. `vendorId`, `purchaseId`) never reaches an MCP
 * payload any more than the top-level `entityId` does.
 */
function collectChangeRefs(
  entityType: AuditEntityType,
  changes: AuditChanges | null,
): EntityRef[] {
  if (!changes) return [];
  const dbTable = entityManifest[entityType].dbTable;
  if (!dbTable) return [];

  const refs: EntityRef[] = [];
  for (const [field, diff] of Object.entries(changes)) {
    const targetEntity = EDGE_KEY_TARGET_ENTITY.get(`${dbTable}.${field}`);
    if (!targetEntity) continue;
    for (const value of [diff.from, diff.to]) {
      if (isNonEmptyString(value))
        refs.push(parseEntityRef(targetEntity, value));
    }
  }
  return refs;
}

/**
 * Remap a single entry's `changes` diff, replacing any FK-shaped `from`/`to`
 * value with its resolved shortcode. Non-FK fields, and values that didn't
 * resolve (deleted rows, malformed data, anything not in `shortcodeByRef`),
 * pass through unchanged — never coerced to null. `shortcodeByRef` must
 * already contain every ref `collectChangeRefs` found for this entry.
 */
function remapChangeShortcodes(
  entityType: AuditEntityType,
  changes: AuditChanges | null,
  shortcodeByRef: Map<string, string>,
): Record<string, { from?: AuditJsonValue; to?: AuditJsonValue }> | null {
  if (!changes) return null;
  const dbTable = entityManifest[entityType].dbTable;

  const resolveValue = (
    targetEntity: ShortcodeEntity,
    value: AuditJsonValue | undefined,
  ): AuditJsonValue | undefined =>
    isNonEmptyString(value)
      ? (shortcodeByRef.get(entityRefKey(targetEntity, value)) ?? value)
      : value;

  const remapped: Record<
    string,
    { from?: AuditJsonValue; to?: AuditJsonValue }
  > = {};
  for (const [field, diff] of Object.entries(changes)) {
    const targetEntity = dbTable
      ? EDGE_KEY_TARGET_ENTITY.get(`${dbTable}.${field}`)
      : undefined;
    remapped[field] = targetEntity
      ? {
          from: resolveValue(targetEntity, diff.from),
          to: resolveValue(targetEntity, diff.to),
        }
      : { from: diff.from, to: diff.to };
  }
  return remapped;
}

/** OAuth client display names, resolved at read time (clients can be renamed). */
async function lookupOauthClientNames(
  db: Database,
  clientIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (clientIds.length === 0) return new Map();
  const rows = await unwrapDb(db)
    .select({ clientId: oauthClient.clientId, name: oauthClient.name })
    .from(oauthClient)
    .where(inArray(oauthClient.clientId, [...new Set(clientIds)]));
  return new Map(rows.map((row) => [row.clientId, row.name]));
}

/**
 * Query audit log entries with pagination.
 */
export async function getAuditLog(
  db: Database,
  params: {
    entityType?: AuditEntityType;
    entityId?: string;
    /**
     * Repo-only cohort narrowing (uuids, not shortcodes): the entity timeline
     * reads one audit window for every record in a list scope. Never exposed
     * on the browser/MCP audit input, whose subject is a single shortcode.
     */
    entityIds?: readonly string[];
    channel?: AuditChannel | AuditChannel[];
    oauthClientId?: string;
    /** Device and Run uuids; the workflow resolves the public shortcodes. */
    deviceId?: DeviceId;
    runId?: ImportRunId;
    // Both ISO date strings, same encoding as `cursor` below — inclusive
    // bounds on `createdAt`.
    createdAtFrom?: string;
    createdAtTo?: string;
    limit: number;
    cursor?: string; // Opaque composite cursor; legacy ISO timestamps accepted
  },
): Promise<AuditLogListOut> {
  const conditions: SQL[] = [];

  if (params.entityType) {
    conditions.push(eq(auditLog.entityType, params.entityType));
  }

  if (params.entityId) {
    conditions.push(eq(auditLog.entityId, params.entityId));
  }

  if (params.entityIds) {
    if (params.entityIds.length === 0) return { entries: [] };
    conditions.push(inArray(auditLog.entityId, [...params.entityIds]));
  }

  const channelCondition = eqAny(auditLog.channel, params.channel);
  if (channelCondition) conditions.push(channelCondition);
  if (params.oauthClientId)
    conditions.push(eq(auditLog.oauthClientId, params.oauthClientId));
  if (params.deviceId) conditions.push(eq(auditLog.deviceId, params.deviceId));
  if (params.runId) conditions.push(eq(auditLog.runId, params.runId));

  if (params.createdAtFrom) {
    conditions.push(gte(auditLog.createdAt, new Date(params.createdAtFrom)));
  }

  if (params.createdAtTo) {
    conditions.push(lte(auditLog.createdAt, new Date(params.createdAtTo)));
  }

  // Cursor-based pagination: get entries older than cursor. ANDs with
  // `createdAtTo` above rather than reconciling the two — both are upper
  // bounds on the same indexed column, so the extra predicate is index-served
  // and simply narrows the window further.
  if (params.cursor) {
    const cursor = decodeAuditCursor(params.cursor);
    if (cursor.id) {
      const cursorCondition = or(
        lt(auditLog.createdAt, cursor.createdAt),
        and(
          eq(auditLog.createdAt, cursor.createdAt),
          lt(auditLog.id, cursor.id),
        ),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    } else {
      conditions.push(lt(auditLog.createdAt, cursor.createdAt));
    }
  }

  const entries = await unwrapDb(db).query.auditLog.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: [desc(auditLog.createdAt), desc(auditLog.id)],
    limit: params.limit + 1, // Fetch one extra to determine if there's more
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      device: { columns: { shortcode: true, name: true } },
      run: { columns: { shortcode: true } },
    },
  });

  // Determine if there are more entries
  const hasMore = entries.length > params.limit;
  const returnEntries: AuditLogRow[] = (
    hasMore ? entries.slice(0, params.limit) : entries
  ).map((entry) => ({
    ...entry,
    action: auditActionSchema.parse(entry.action),
    channel: auditChannelSchema.parse(entry.channel),
    changes:
      entry.changes == null ? null : auditChangesSchema.parse(entry.changes),
  }));
  const lastEntry = returnEntries.at(-1);
  const nextCursor =
    hasMore && lastEntry ? encodeAuditCursor(lastEntry) : undefined;

  const entryRefs: EntityRef[] = returnEntries.map((entry) =>
    parseEntityRef(entry.entityType, entry.entityId),
  );
  const changeRefs = returnEntries.flatMap((entry) =>
    collectChangeRefs(entry.entityType, entry.changes),
  );

  // AuditLog's identity FK guarantees every subject has an Entity row. Read
  // those codes once, including codes inside changes, instead of querying each
  // payload table again for the same shortcodes.
  const [nameByRef, displayImageByRef, clientNames, identities] =
    await Promise.all([
      lookupEntityLabels(db, entryRefs),
      resolveEntityDisplayImages(
        db,
        entryRefs.map(({ entity, id }) => ({
          entityType: entity,
          entityId: id,
        })),
      ),
      lookupOauthClientNames(
        db,
        returnEntries.flatMap((entry) => entry.oauthClientId ?? []),
      ),
      identityShortcodes(
        db,
        [...entryRefs, ...changeRefs].map((ref) => ref.id),
      ),
    ]);
  const shortcodeByRef = new Map(
    changeRefs.flatMap((ref) => {
      const identity = identities.get(ref.id);
      const shortcode =
        identity?.kind === ref.entity ? identity.shortcode : null;
      return shortcode
        ? [
            [
              entityRefKey(ref.entity, ref.id),
              parseShortcodeFor(ref.entity, shortcode),
            ] as const,
          ]
        : [];
    }),
  );

  return {
    entries: returnEntries.map(
      ({
        id,
        entityId,
        changes,
        oauthClientId,
        deviceId: _deviceId,
        runId: _runId,
        device,
        run,
        ...entry
      }) => ({
        ...entry,
        oauthClient: oauthClientId
          ? { id: oauthClientId, name: clientNames.get(oauthClientId) ?? null }
          : null,
        device: device
          ? {
              id: parseShortcodeFor("device", device.shortcode),
              name: device.name,
            }
          : null,
        runId: run ? parseShortcodeFor("importRun", run.shortcode) : null,
        entryKey: encodeAuditCursor({ id, createdAt: entry.createdAt }),
        // `Entity` still knows a hard-deleted payload's code.
        entityId: identities.get(entityId)?.shortcode ?? null,
        canonicalEntityId: identities.get(entityId)?.canonicalShortcode ?? null,
        entityName:
          nameByRef.get(entityRefKey(entry.entityType, entityId)) ?? null,
        displayImage:
          displayImageByRef.get(entityRefKey(entry.entityType, entityId)) ??
          null,
        changes: remapChangeShortcodes(
          entry.entityType,
          changes,
          shortcodeByRef,
        ),
      }),
    ),
    nextCursor,
  };
}

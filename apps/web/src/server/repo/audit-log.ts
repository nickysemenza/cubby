import type {
  AuditEntityType,
  AuditJsonValue,
  AuditLogListOut,
} from "@cubby/schemas/audit";
import type { ActorContext, AuditSource } from "@cubby/schemas/context";
import {
  entityManifest,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { and, desc, eq, gte, lt, lte, or, type SQL } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { EDGE_KEY_TARGET_ENTITY } from "~/server/db/entity-incoming-edges";
import { auditLog } from "~/server/db/schema";
import { eqAny, unwrapDb } from "~/server/repo/database-helpers";
import {
  type EntityRef,
  lookupShortcodes,
  refKey,
} from "~/server/repo/shortcode-resolver";

// Action types for audit entries
type AuditAction = "create" | "update" | "delete";

// Input for the audit entry (without actor context)
export interface AuditEntryInput {
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  changes?: Record<string, { from: unknown; to: unknown }>;
}

// User info included in audit log entries
type AuditLogUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
} | null;

// Output type for audit log entries with user relation
type AuditLogRow = Omit<
  typeof auditLog.$inferSelect,
  "action" | "changes" | "source"
> & {
  action: AuditAction;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  source: AuditSource;
  user: AuditLogUser;
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
    const payload = JSON.parse(atob(padded)) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof payload.createdAt !== "string" ||
      typeof payload.id !== "string"
    ) {
      throw new Error("Malformed audit log cursor");
    }
    const createdAt = new Date(payload.createdAt);
    if (Number.isNaN(createdAt.getTime()) || payload.id.length === 0) {
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
export function computeChanges<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: (keyof T)[],
): Record<string, { from: unknown; to: unknown }> | undefined {
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  for (const field of fields) {
    const fromVal = before[field];
    const toVal = after[field];

    // Deep compare for objects (like JSONB fields)
    const fromStr = JSON.stringify(fromVal);
    const toStr = JSON.stringify(toVal);

    if (fromStr !== toStr) {
      changes[field as string] = { from: fromVal, to: toVal };
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
 * Insert an audit log entry.
 */
export async function logAuditEntry(
  db: Database | DrizzleTransaction,
  actor: ActorContext,
  entry: AuditEntryInput,
): Promise<void> {
  await unwrapDb(db).insert(auditLog).values({
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    changes: entry.changes,
    userId: actor.userId,
    source: actor.source,
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
    userId: actor.userId,
    source: actor.source,
  }));

  await unwrapDb(db).insert(auditLog).values(auditRecords);
}

/**
 * Build delete audit entries for a batch of parent ids, attaching per-parent
 * cascade counts. `cascades` maps each change key (e.g. "cascadedImages") to a
 * parentId→count record; only counts > 0 are emitted, and an entry with no
 * cascades gets `changes: undefined`. Shared by the product/location/recipe
 * delete paths so the count-and-assemble shape lives in one place.
 */
export function buildCascadeAuditEntries(
  entityType: AuditEntityType,
  ids: string[],
  cascades: Record<string, Record<string, number>> = {},
): AuditEntryInput[] {
  return ids.map((id) => {
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, byParent] of Object.entries(cascades)) {
      const count = byParent[id] ?? 0;
      if (count > 0) changes[key] = { from: count, to: 0 };
    }
    return {
      entityType,
      entityId: id,
      action: "delete" as const,
      changes: Object.keys(changes).length > 0 ? changes : undefined,
    };
  });
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
  changes: Record<string, { from: unknown; to: unknown }> | null,
): EntityRef[] {
  if (!changes) return [];
  const dbTable = entityManifest[entityType].dbTable;
  if (!dbTable) return [];

  const refs: EntityRef[] = [];
  for (const [field, diff] of Object.entries(changes)) {
    const targetEntity = EDGE_KEY_TARGET_ENTITY.get(`${dbTable}.${field}`);
    if (!targetEntity) continue;
    for (const value of [diff.from, diff.to]) {
      if (typeof value === "string" && value.length > 0) {
        refs.push({ entity: targetEntity, id: value });
      }
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
  changes: Record<string, { from: unknown; to: unknown }> | null,
  shortcodeByRef: Map<string, string>,
): Record<string, { from?: AuditJsonValue; to?: AuditJsonValue }> | null {
  if (!changes) return null;
  const dbTable = entityManifest[entityType].dbTable;

  // Every value here already round-tripped through the `changes` jsonb
  // column, so it is guaranteed to be plain JSON by the time it's read back
  // (see `AuditJsonValue`'s doc comment) — this cast is the trust boundary,
  // not a runtime check.
  const asJson = (value: unknown) => value as AuditJsonValue | undefined;
  const resolveValue = (
    targetEntity: ShortcodeEntity,
    value: unknown,
  ): AuditJsonValue | undefined =>
    typeof value === "string" && value.length > 0
      ? asJson(shortcodeByRef.get(refKey(targetEntity, value)) ?? value)
      : asJson(value);

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
      : { from: asJson(diff.from), to: asJson(diff.to) };
  }
  return remapped;
}

/**
 * Query audit log entries with pagination.
 */
export async function getAuditLog(
  db: Database,
  params: {
    entityType?: AuditEntityType;
    entityId?: string;
    source?: AuditSource | AuditSource[];
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

  const sourceCondition = eqAny(auditLog.source, params.source);
  if (sourceCondition) {
    conditions.push(sourceCondition);
  }

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
    conditions.push(
      cursor.id
        ? (or(
            lt(auditLog.createdAt, cursor.createdAt),
            and(
              eq(auditLog.createdAt, cursor.createdAt),
              lt(auditLog.id, cursor.id),
            ),
          ) as SQL)
        : lt(auditLog.createdAt, cursor.createdAt),
    );
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
    },
  });

  // Determine if there are more entries
  const hasMore = entries.length > params.limit;
  const returnEntries: AuditLogRow[] = (
    hasMore ? entries.slice(0, params.limit) : entries
  ).map((entry) => ({
    ...entry,
    action: entry.action as AuditAction,
    source: entry.source as AuditSource,
    changes: entry.changes ?? null,
  }));
  const nextCursor = hasMore
    ? returnEntries[returnEntries.length - 1]
      ? encodeAuditCursor(returnEntries[returnEntries.length - 1]!)
      : undefined
    : undefined;

  // One batched round-trip covers both the top-level `entityId` AND every
  // FK-shaped value inside each entry's `changes` diff — never a per-row query.
  const shortcodeByRef = await lookupShortcodes(db, [
    ...returnEntries.map((entry) => ({
      entity: entry.entityType,
      id: entry.entityId,
    })),
    ...returnEntries.flatMap((entry) =>
      collectChangeRefs(entry.entityType, entry.changes),
    ),
  ]);

  return {
    entries: returnEntries.map(({ id, entityId, changes, ...entry }) => ({
      ...entry,
      entryKey: encodeAuditCursor({ id, createdAt: entry.createdAt }),
      entityId: shortcodeByRef.get(refKey(entry.entityType, entityId)) ?? null,
      changes: remapChangeShortcodes(entry.entityType, changes, shortcodeByRef),
    })),
    nextCursor,
  };
}

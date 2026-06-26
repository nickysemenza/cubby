import type { AuditEntityType } from "@cubby/schemas/audit";
import type { ActorContext, AuditSource } from "@cubby/schemas/context";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { auditLog } from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";

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
 * Query audit log entries with pagination.
 */
export async function getAuditLog(
  db: Database,
  params: {
    entityType?: AuditEntityType;
    entityId?: string;
    limit: number;
    cursor?: string; // ISO date string for cursor-based pagination
  },
): Promise<{ entries: AuditLogRow[]; nextCursor?: string }> {
  const conditions: ReturnType<typeof eq>[] = [];

  if (params.entityType) {
    conditions.push(eq(auditLog.entityType, params.entityType));
  }

  if (params.entityId) {
    conditions.push(eq(auditLog.entityId, params.entityId));
  }

  // Cursor-based pagination: get entries older than cursor
  if (params.cursor) {
    conditions.push(lt(auditLog.createdAt, new Date(params.cursor)));
  }

  const entries = await unwrapDb(db).query.auditLog.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: desc(auditLog.createdAt),
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
    ? returnEntries[returnEntries.length - 1]?.createdAt.toISOString()
    : undefined;

  return { entries: returnEntries, nextCursor };
}

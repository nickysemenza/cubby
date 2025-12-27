import { and, desc, eq, lt } from "drizzle-orm";
import type { ActorContext } from "~/schemas/context";
import type { OrganizationId } from "~/schemas/identifiers";
import type { Database, DrizzleTransaction } from "~/server/db";
import { auditLog } from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";

// Entity types that can be audited
export type AuditEntityType =
  | "product"
  | "location"
  | "inventory"
  | "recipe"
  | "ingredient";

// Action types for audit entries
type AuditAction = "create" | "update" | "delete";

// Input for the audit entry (without actor context)
interface AuditEntryInput {
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
type AuditLogRow = typeof auditLog.$inferSelect & {
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
    organizationId: actor.organizationId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    changes: entry.changes,
    userId: actor.userId,
    source: actor.source,
  });
}

/**
 * Query audit log entries with pagination.
 */
export async function getAuditLog(
  db: Database,
  params: {
    organizationId: OrganizationId;
    entityType?: AuditEntityType;
    entityId?: string;
    limit: number;
    cursor?: string; // ISO date string for cursor-based pagination
  },
): Promise<{ entries: AuditLogRow[]; nextCursor?: string }> {
  const conditions = [eq(auditLog.organizationId, params.organizationId)];

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
    where: and(...conditions),
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
  const returnEntries = hasMore ? entries.slice(0, params.limit) : entries;
  const nextCursor = hasMore
    ? returnEntries[returnEntries.length - 1]?.createdAt.toISOString()
    : undefined;

  return { entries: returnEntries, nextCursor };
}

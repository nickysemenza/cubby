import { auditEntitySchema } from "@cubby/schemas/audit";
import { and, desc, eq, sql } from "drizzle-orm";

import {
  repositoryQueries as unwrapDb,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { auditLog } from "~/server/db/retained-tables";

/**
 * Append-only history advances on every matching write, including ABA edits.
 * Transaction timestamps can tie, and random UUID order is not write order.
 */
export async function fieldWriteRevision(
  db: RepositoryQueryInput,
  entity: string,
  recordId: string,
  field: string,
) {
  const kind = auditEntitySchema.safeParse(entity);
  if (!kind.success) return null;
  const [row] = await unwrapDb(db)
    .select({ revision: sql<string>`count(*)::text` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityKind, kind.data),
        sql`${auditLog.entityId} = ${recordId}::uuid`,
        eq(auditLog.action, "update"),
        sql`${auditLog.changes} ? ${field}`,
      ),
    );
  return row?.revision ?? "0";
}

/** Audit history distinguishes an unchanged save from a value changed and restored. */
export async function latestFieldWrite(
  db: RepositoryQueryInput,
  entity: string,
  recordId: string,
  field: string,
) {
  const kind = auditEntitySchema.safeParse(entity);
  if (!kind.success) return null;
  const [row] = await unwrapDb(db)
    .select({ id: auditLog.id, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityKind, kind.data),
        sql`${auditLog.entityId} = ${recordId}::uuid`,
        eq(auditLog.action, "update"),
        sql`${auditLog.changes} ? ${field}`,
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1);
  return row ?? null;
}

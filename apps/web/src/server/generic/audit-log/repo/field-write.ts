import { auditEntitySchema } from "@cubby/schemas/audit";
import { and, eq, sql, type SQL } from "drizzle-orm";

import {
  repositoryQueries as unwrapDb,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { auditLog } from "~/server/db/retained-tables";

const revisionMatch = (entity: SQL, recordId: SQL, field: SQL) =>
  and(
    eq(auditLog.entityKind, entity),
    sql`${auditLog.entityId} = ${recordId}::uuid`,
    eq(auditLog.action, "update"),
    sql`${auditLog.changes} ? ${field}`,
  );

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
    .where(revisionMatch(sql`${kind.data}`, sql`${recordId}`, sql`${field}`));
  return row?.revision ?? "0";
}

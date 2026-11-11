import { auditEntitySchema } from "@cubby/schemas/audit";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";

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

/** The same append-only revision for a read's subjects, in input order. */
export async function fieldWriteRevisions(
  db: RepositoryQueryInput,
  subjects: readonly { entity: string; recordId: string; field: string }[],
): Promise<(string | null)[]> {
  const revisions: (string | null)[] = subjects.map(() => null);
  const valid = subjects.flatMap((subject, ordinal) => {
    const kind = auditEntitySchema.safeParse(subject.entity);
    return kind.success ? [{ ...subject, entity: kind.data, ordinal }] : [];
  });
  if (!valid.length) return revisions;
  const result = await unwrapDb(db).execute<{
    ordinal: number;
    revision: string;
  }>(sql`
    SELECT requested.ordinal, (SELECT count(*)::text FROM ${auditLog}
      WHERE ${revisionMatch(sql`requested.entity`, sql`requested."recordId"`, sql`requested.field`)}) AS revision
    FROM jsonb_to_recordset(${JSON.stringify(valid)}::jsonb)
      AS requested(ordinal int, entity text, "recordId" uuid, field text)`);
  for (const row of result.rows) revisions[row.ordinal] = row.revision;
  return revisions;
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

/** `latestFieldWrite` for many records of one entity field in one read. */
export async function latestFieldWrites(
  db: RepositoryQueryInput,
  entity: string,
  field: string,
  recordIds: readonly string[],
): Promise<Map<string, { id: string; createdAt: Date }>> {
  const writes = new Map<string, { id: string; createdAt: Date }>();
  const kind = auditEntitySchema.safeParse(entity);
  if (!kind.success || !recordIds.length) return writes;
  const result = await unwrapDb(db).execute<{
    recordId: string;
    id: string;
    createdAt: string | Date;
  }>(sql`
    SELECT requested."recordId", latest.id, latest."createdAt"
    FROM unnest(ARRAY[${sql.join(
      recordIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[]) AS requested("recordId")
    CROSS JOIN LATERAL (
      SELECT ${auditLog.id} AS id, ${auditLog.createdAt} AS "createdAt" FROM ${auditLog}
      WHERE ${revisionMatch(sql`${kind.data}`, sql`requested."recordId"`, sql`${field}`)}
      ORDER BY ${auditLog.createdAt} DESC, ${auditLog.id} DESC
      LIMIT 1
    ) latest`);
  for (const row of result.rows)
    writes.set(row.recordId, {
      id: row.id,
      createdAt: new Date(row.createdAt),
    });
  return writes;
}

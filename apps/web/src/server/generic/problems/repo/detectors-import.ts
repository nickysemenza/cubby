import { storedImportFix } from "@cubby/schemas/purchase-import";
import { and, count, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { quotedTable } from "~/server/db/helpers/related";
import { entityIdentity, runFinding } from "~/server/db/schema";
import { activeFindingSql } from "~/server/domains/purchase-import/repo/finding-expiry";
import { runFindingColumns } from "~/server/domains/purchase-import/repo/run-finding";
import { obsoleteExecutionFindingSql } from "~/server/domains/purchase-import/repo/run-retirement";

const openFindingWhere = (now: Date) =>
  and(
    activeFindingSql("RunFinding", now),
    sql`NOT ${obsoleteExecutionFindingSql(quotedTable(runFinding))}`,
  );

export async function countOpenRunFindings(db: Database) {
  const [row] = await getDb(db)
    .select({ count: count() })
    .from(runFinding)
    .where(openFindingWhere(new Date()));
  return row?.count ?? 0;
}

/** Count before LIMIT; only the requested rows cross the hydration boundary. */
export async function findOpenRunFindingsPage(db: Database, limit?: number) {
  if (limit === 0) return { items: [], count: await countOpenRunFindings(db) };
  const query = getDb(db)
    .select({
      id: runFindingColumns.id,
      targetShortcode: entityIdentity.shortcode,
      kind: runFindingColumns.kind,
      summary: runFindingColumns.summary,
      probability: runFindingColumns.probability,
      proposedFix: runFindingColumns.proposedFix,
      createdAt: runFindingColumns.createdAt,
      totalCount: sql<number>`count(*) over()::int`,
    })
    .from(runFinding)
    .leftJoin(entityIdentity, eq(runFinding.entityId, entityIdentity.id))
    .where(openFindingWhere(new Date()))
    .orderBy(runFinding.createdAt, runFinding.id);
  const rows = await (limit === undefined || limit === Number.POSITIVE_INFINITY
    ? query
    : query.limit(limit));
  const items = rows.map((row) => ({
    id: row.id,
    targetId: row.targetShortcode,
    kind: row.kind,
    summary: row.summary,
    probability: row.probability,
    proposedFix: storedImportFix.parse(row.proposedFix),
    createdAt: row.createdAt,
  }));
  return { items, count: rows[0]?.totalCount ?? 0 };
}

export async function findOpenRunFindings(db: Database) {
  return (await findOpenRunFindingsPage(db)).items;
}

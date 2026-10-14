import { storedImportFix } from "@cubby/schemas/purchase-import";
import { and, eq, lt, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { entityIdentity, runFinding } from "~/server/db/schema";
import { obsoleteExecutionFindingSql } from "~/server/purchase-import/run-retirement";
import { getDb } from "~/server/repo/database-helpers";

export async function findOpenRunFindings(db: Database) {
  const database = getDb(db);
  const now = new Date();
  await database
    .update(runFinding)
    .set({ status: "dismissed", resolvedAt: now, updatedAt: now })
    .where(and(eq(runFinding.status, "open"), lt(runFinding.expiresAt, now)));
  const rows = await database
    .select({
      id: runFinding.id,
      targetShortcode: entityIdentity.shortcode,
      kind: runFinding.kind,
      summary: runFinding.summary,
      probability: runFinding.probability,
      proposedFix: runFinding.proposedFix,
      createdAt: runFinding.createdAt,
    })
    .from(runFinding)
    .leftJoin(entityIdentity, eq(runFinding.entityId, entityIdentity.id))
    .where(
      and(
        eq(runFinding.status, "open"),
        sql`NOT ${obsoleteExecutionFindingSql('"RunFinding"')}`,
      ),
    )
    .orderBy(runFinding.createdAt);
  return rows.map((row) => ({
    id: row.id,
    targetId: row.targetShortcode,
    kind: row.kind,
    summary: row.summary,
    probability: row.probability,
    proposedFix: storedImportFix.parse(row.proposedFix),
    createdAt: row.createdAt,
  }));
}

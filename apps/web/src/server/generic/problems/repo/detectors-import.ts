import { storedImportFix } from "@cubby/schemas/purchase-import";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { entityIdentity, runFinding } from "~/server/db/schema";
import { activeFindingSql } from "~/server/domains/purchase-import/repo/finding-expiry";
import { obsoleteExecutionFindingSql } from "~/server/domains/purchase-import/repo/run-retirement";

export async function findOpenRunFindings(db: Database) {
  const database = getDb(db);
  const now = new Date();
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
        activeFindingSql("RunFinding", now),
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

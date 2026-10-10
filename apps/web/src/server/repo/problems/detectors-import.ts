import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, lt } from "drizzle-orm";

import type { Database } from "~/server/db";
import { purchase, runFinding } from "~/server/db/schema";
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
      purchaseShortcode: purchase.shortcode,
      kind: runFinding.kind,
      summary: runFinding.summary,
      probability: runFinding.probability,
      proposedFix: runFinding.proposedFix,
      createdAt: runFinding.createdAt,
    })
    .from(runFinding)
    .leftJoin(purchase, eq(runFinding.entityId, purchase.id))
    .where(eq(runFinding.status, "open"))
    .orderBy(runFinding.createdAt);
  return rows.map((row) => ({
    id: row.id,
    purchaseId: row.purchaseShortcode
      ? parseShortcodeFor("purchase", row.purchaseShortcode)
      : null,
    kind: row.kind,
    summary: row.summary,
    probability: row.probability,
    proposedFix: row.proposedFix,
    createdAt: row.createdAt,
  }));
}

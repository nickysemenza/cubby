import { storedFieldDecision } from "@cubby/schemas/derived-value";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { HOUSEHOLD_PROJECT_SHORTCODE } from "@cubby/schemas/project-fields";
import { workDiagnosticCounts } from "@cubby/schemas/work-diagnostic-facts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { declaredStoredSourceSql } from "~/server/db/derived-source-sql";
import { getDb, isTransaction, notDeleted } from "~/server/db/helpers";
import { project } from "~/server/db/schema";

const publicationRow = workDiagnosticCounts.extend({
  counts: workDiagnosticCounts.shape.counts.nullable(),
  id: z.string(),
  computedAt: z.coerce.date().nullable(),
  decidedBy: z.unknown(),
  pending: z.boolean(),
  stale: z.boolean(),
  error: z.string().nullable(),
});

/** Keep the unbounded finding payload inside SQL; only compact publication metadata crosses here. */
export const loadWorkDiagnosticFacts = async (db: Database) => {
  const result = await getDb(db).execute(sql`
    SELECT p.id, v.value->'counts' AS counts, v."computedAt", v."decidedBy",
      false AS pending, false AS stale, NULL::text AS error
    FROM "Project" p
    LEFT JOIN LATERAL (${declaredStoredSourceSql("project", "workDiagnosticFacts", sql`p.id`)}) v ON true
    WHERE p.shortcode = ${HOUSEHOLD_PROJECT_SHORTCODE} AND ${notDeleted("p")}
    LIMIT 1`);
  const row = z.array(publicationRow).parse(result.rows)[0];
  if (!row) return null;
  const decision = storedFieldDecision.safeParse(row.decidedBy);
  return {
    id: row.id,
    counts:
      row.computedAt &&
      decision.success &&
      decision.data.outcome.kind === "value"
        ? (row.counts ?? null)
        : null,
    computedAt: row.computedAt?.toISOString() ?? null,
    stale: row.stale,
    pending: row.pending,
    error: row.error,
  };
};

/** Diagnostics accept mixed-age inputs; records created mid-pass converge on the next pass. */
export const loadWorkDiagnosticComputeTargets = async (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) => {
  if (isTransaction(db))
    throw new Error("Work diagnostics compute outside a transaction");
  if (ids.length === 0) return { db, ids: [] };
  const anchors = await getDb(db)
    .select({ id: project.id })
    .from(project)
    .where(
      and(
        notDeleted(project),
        eq(project.shortcode, HOUSEHOLD_PROJECT_SHORTCODE),
        inArray(
          project.id,
          ids.map((id) => parseEntityId("project", id)),
        ),
      ),
    );
  return { db, ids: anchors.map((anchor) => anchor.id) };
};

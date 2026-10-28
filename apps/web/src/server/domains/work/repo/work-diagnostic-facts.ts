import { storedFieldDecision } from "@cubby/schemas/derived-value";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { HOUSEHOLD_PROJECT_SHORTCODE } from "@cubby/schemas/project-fields";
import { workDiagnosticCounts } from "@cubby/schemas/work-diagnostic-facts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";
import type { Database, DrizzleTransaction } from "~/server/db";
import { getDb, isTransaction, notDeleted } from "~/server/db/helpers";
import { householdDaySql } from "~/server/db/helpers/query";
import { cookbook, product, project } from "~/server/db/schema";
import { fanoutTargetMatches } from "~/server/generic/derived/repo/fanout";
import { loadStoredDerived } from "~/server/generic/derived/repo/read";
import {
  owedWorkItem,
  workPendingWhere,
} from "~/server/generic/jobs/repo/work-items";

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
  const target = sql`${"project.workDiagnosticFacts"}::text`;
  const pending = workPendingWhere((column) =>
    fanoutTargetMatches(column, target),
  );
  const result = await getDb(db).execute(sql`
    SELECT p.id, v.value->'counts' AS counts, v."computedAt", v."decidedBy",
      (w.ref IS NOT NULL OR ${pending}) AS pending,
      (w.ref IS NOT NULL OR ${pending} OR
        ${householdDaySql(sql`v."computedAt"`)} < ${householdLocalDate()}::date) IS TRUE AS stale,
      w."lastError" AS error
    FROM "Project" p
    LEFT JOIN "DerivedValue" v ON v."entityId" = p.id AND v.key = 'workDiagnosticFacts'
    LEFT JOIN LATERAL ${owedWorkItem(target, sql`p.id`)} w ON true
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

/** Canonical detectors may consume stored quality/rollups only when every input is available. */
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
  if (anchors.length > 0) {
    const sources = [
      { entity: "product", table: product, key: "dataQuality" },
      { entity: "cookbook", table: cookbook, key: "dataQuality" },
      { entity: "project", table: project, key: "rollups" },
    ] as const;
    for (const source of sources) {
      const rows = await getDb(db)
        .select({ id: source.table.id })
        .from(source.table)
        .where(notDeleted(source.table));
      // Preparation may inspect the population; display never takes this path.
      for (let offset = 0; offset < rows.length; offset += 500) {
        const ids = rows.slice(offset, offset + 500).map((row) => row.id);
        const reads = await loadStoredDerived(db, source.entity, ids, [
          source.key,
        ]);
        if (
          ids.some((id) => {
            const read = reads.get(id)?.get(source.key);
            return !read?.resultExists || read.stale || read.error;
          })
        )
          throw new Error(
            `Work diagnostic inputs are unavailable or stale: ${source.entity}.${source.key}.`,
          );
      }
    }
  }
  return { db, ids: anchors.map((anchor) => anchor.id) };
};

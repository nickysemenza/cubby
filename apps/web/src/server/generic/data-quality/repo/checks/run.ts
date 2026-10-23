import { and, eq, sql } from "drizzle-orm";
import { groupBy } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { photoRunImage, run, runOperation } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
const RUN_QUALITY_RULES_VERSION = 1;
type RunQualityRecord = Awaited<
  ReturnType<typeof loadRunQualityRecords>
>[number];
const observed = qualityCheck.observed<RunQualityRecord>;

export const runChecks = defineStoredEntityChecks({
  entity: "run",
  table: run,
  rulesVersion: RUN_QUALITY_RULES_VERSION,
  load: loadRunQualityRecords,
  checks: {
    run_display_image: qualityCheck.hasImage,
    run_attribution: qualityCheck.required("actorName"),
    run_timeline: observed((r) =>
      r.endedAt === null
        ? r.status !== "completed" &&
          r.status !== "failed" &&
          r.status !== "dispatch_failed"
        : r.endedAt >= r.startedAt,
    ),
    run_target_outcomes: qualityCheck.when(
      (r: RunQualityRecord) =>
        r.status === "completed" &&
        (r.purpose === "purchase_validation" ||
          r.purpose === "product_enrichment" ||
          r.purpose === "photo_inventory"),
      // Generic receipts are immutable history; only photo membership is a live roster.
      observed(
        (r) =>
          r.outcomes.length > 0 &&
          r.outcomes.every(
            (target) =>
              (target.state === "completed" ||
                target.state === "skipped" ||
                target.state === "unavailable") &&
              target.outcome !== null &&
              target.completedAt !== null &&
              (target.state === "completed" || !!target.warning?.trim()),
          ),
      ),
    ),
  },
});

async function loadRunQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  const database = unwrapDb(db);
  const [runs, receipts, photos] = await Promise.all([
    database
      .select({
        id: run.id,
        shortcode: run.shortcode,
        hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("run", sql`${sql.identifier("Run")}.${sql.identifier("id")}`)}`,
        actorName: run.actorName,
        status: run.status,
        purpose: run.purpose,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      })
      .from(run)
      .where(
        and(notDeleted(run), sql`${run.id} = ANY(${uuidArrayParam(ids)})`),
      ),
    database
      .select({
        runId: runOperation.runId,
        state: sql<
          string | null
        >`${runOperation.result}->${"target"}->>${"state"}`,
        outcome: sql<
          string | null
        >`${runOperation.result}->${"target"}->>${"outcome"}`,
        completedAt: sql<
          string | null
        >`${runOperation.result}->${"target"}->>${"completedAt"}`,
        warning: sql<
          string | null
        >`${runOperation.result}->${"target"}->>${"warning"}`,
      })
      .from(runOperation)
      .where(
        and(
          sql`${runOperation.runId} = ANY(${uuidArrayParam(ids)})`,
          eq(runOperation.kind, "target_outcome"),
          eq(runOperation.state, "completed"),
        ),
      ),
    database
      .select({
        runId: photoRunImage.runId,
        state: photoRunImage.state,
        outcome: photoRunImage.outcome,
        completedAt: sql<string | null>`${photoRunImage.completedAt}::text`,
        warning: photoRunImage.skipReason,
      })
      .from(photoRunImage)
      .where(sql`${photoRunImage.runId} = ANY(${uuidArrayParam(ids)})`),
  ]);
  const genericByRun = groupBy(receipts, (row) => row.runId);
  const photoByRun = groupBy(photos, (row) => row.runId);
  return runs.map((row) => ({
    ...row,
    outcomes:
      (row.purpose === "photo_inventory"
        ? photoByRun[row.id]
        : genericByRun[row.id]) ?? [],
  }));
}

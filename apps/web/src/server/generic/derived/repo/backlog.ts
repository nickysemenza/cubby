import {
  ASSESSMENT_READ_LABEL,
  ASSESSMENT_READ_TARGET,
} from "@cubby/schemas/assessment-read-publication";
import type { DerivedBacklog } from "@cubby/schemas/derived-backlog";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import {
  entityStoredDerivedDeclarations,
  storedDerivedDeclarations,
} from "~/server/db/derived-declarations";
import { DERIVED_DRAIN_JOB_KEY } from "~/server/db/derived-trigger-ddl";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { readAssessmentPublicationActivity } from "~/server/generic/assessment/repo/read-publication";
import { drainBacklog } from "~/server/generic/jobs/repo/work-items";

/** Committed publications are reported per minute over this window. */
const RECENT_MINUTES = 15;

const activityBucket = z.object({
  age: z.number().int(),
  count: z.number().int(),
});
const perMinute = (rows: readonly z.infer<typeof activityBucket>[]) => {
  const counts = Array.from({ length: RECENT_MINUTES }, () => 0);
  for (const row of rows)
    if (row.age >= 0 && row.age < RECENT_MINUTES)
      counts[RECENT_MINUTES - 1 - row.age] =
        (counts[RECENT_MINUTES - 1 - row.age] ?? 0) + row.count;
  return counts;
};

const workStatus = (
  row: Awaited<ReturnType<typeof drainBacklog>>["targets"][number] | undefined,
) => ({
  count: row?.count ?? 0,
  refreshReasons: row?.refreshReasons ?? [],
  states: {
    queued: row?.queued ?? 0,
    running: row?.running ?? 0,
    waiting: row?.waiting ?? 0,
    failed: row?.failed ?? 0,
  },
  nextAttemptAt: row?.nextAttemptAt
    ? z.coerce.date().parse(row.nextAttemptAt).toISOString()
    : null,
});

export async function readDerivedBacklog(
  db: Database,
): Promise<DerivedBacklog> {
  const [{ targets: rows, oldestSeconds }, published, assessmentPublications] =
    await Promise.all([
      // Fanout tickets (`target@column`) count toward the kind they refresh.
      drainBacklog(db, DERIVED_DRAIN_JOB_KEY),
      repositoryQueries(db).execute(
        sql`SELECT floor(extract(epoch FROM now() - "computedAt") / 60)::int AS age, count(*)::int AS count
        FROM "DerivedValue"
        WHERE "computedAt" > now() - ${RECENT_MINUTES} * interval '1 minute'
        GROUP BY 1`,
      ),
      readAssessmentPublicationActivity(db, RECENT_MINUTES),
    ]);
  const values = perMinute(activityBucket.array().parse(published.rows));
  const assessments = perMinute(assessmentPublications);
  const declarations = entityStoredDerivedDeclarations();
  const entityTargets = new Set(declarations.map((entry) => entry.target));
  const internal = new Map(
    storedDerivedDeclarations().flatMap((entry) =>
      entry.kind === "internalRecord"
        ? [[entry.target, entry.label] as const]
        : [],
    ),
  );
  // Old or unknown targets remain visible instead of disappearing into total.
  for (const row of rows)
    if (!entityTargets.has(row.target) && !internal.has(row.target))
      internal.set(row.target, "Other refresh work");
  return {
    oldestWaitingSeconds: oldestSeconds,
    recent: {
      windowMinutes: RECENT_MINUTES,
      perMinute: values.map(
        (count, index) => count + (assessments[index] ?? 0),
      ),
      sources: [
        { target: null, label: "Stored values", perMinute: values },
        {
          target: ASSESSMENT_READ_TARGET,
          label: ASSESSMENT_READ_LABEL,
          perMinute: assessments,
        },
      ],
    },
    total: rows.reduce((sum, row) => sum + row.count, 0),
    kinds: declarations.map((declaration) => {
      const row = rows.find((row) => row.target === declaration.target);
      return {
        entity: declaration.entity,
        field: declaration.key,
        ...workStatus(row),
      };
    }),
    internal: [...internal].map(([target, label]) => ({
      target,
      label,
      ...workStatus(rows.find((row) => row.target === target)),
    })),
  };
}

import {
  parseEntityId,
  type RunId,
  type JobId,
} from "@cubby/schemas/identifiers";
import { jobState, type JobWaitReason } from "@cubby/schemas/job";
import { and, asc, count, desc, eq, ne, type SQL } from "drizzle-orm";

import type {
  JobGroup,
  JobListOut,
  JobSubjectEntity,
} from "~/contracts/job.contract";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import {
  jobFactsOf,
  readRunRollups,
  runDemandWhere,
} from "~/server/generic/jobs/repo/job-queue";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

/** The Job that executes any Run; other kinds are the Run's fan-out. */
const RUN_EXECUTE = "run.execute";

/** Per-kind counts plus each kind's most recently touched Job. */
async function groupsOf(
  db: Database,
  owner: SQL,
  exclude: JobId | null,
  now: Date,
): Promise<JobGroup[]> {
  const where = exclude ? and(owner, ne(job.id, exclude)) : owner;
  const [tallies, latest] = await Promise.all([
    getDb(db)
      .select({
        kind: job.kind,
        state: job.state,
        waitReason: job.waitReason,
        count: count(),
      })
      .from(job)
      .where(where)
      .groupBy(job.kind, job.state, job.waitReason),
    getDb(db)
      .selectDistinctOn([job.kind])
      .from(job)
      .where(where)
      .orderBy(asc(job.kind), desc(job.updatedAt)),
  ]);
  const latestFacts = await jobFactsOf(db, latest, now);
  return Promise.all(
    latest.map(async (row, index) => {
      const states: JobGroup["states"] = {};
      const waitReasons: Partial<Record<JobWaitReason, number>> = {};
      let total = 0;
      for (const tally of tallies) {
        if (tally.kind !== row.kind) continue;
        total += tally.count;
        const state = jobState.parse(tally.state);
        states[state] = (states[state] ?? 0) + tally.count;
        if (tally.waitReason)
          waitReasons[tally.waitReason] =
            (waitReasons[tally.waitReason] ?? 0) + tally.count;
      }
      return {
        kind: row.kind,
        count: total,
        states,
        waitReasons,
        latest: latestFacts[index]!,
      };
    }),
  );
}

async function readJobs(
  db: Database,
  owner: SQL,
  primaryKind: string | null,
  run: { id: RunId; shortcode: string } | null,
): Promise<JobListOut> {
  const now = new Date();
  const [primaryRow] = await getDb(db)
    .select()
    .from(job)
    .where(primaryKind ? and(owner, eq(job.kind, primaryKind)) : owner)
    .orderBy(desc(job.updatedAt))
    .limit(1);
  const [primaryFacts, groups, rollups] = await Promise.all([
    primaryRow ? jobFactsOf(db, [primaryRow], now) : Promise.resolve([]),
    groupsOf(db, owner, primaryRow?.id ?? null, now),
    run ? readRunRollups(db, [run], now) : Promise.resolve([]),
  ]);
  const primary = primaryFacts[0] ?? null;
  return {
    primary,
    groups,
    rollup: rollups[0] ?? null,
  };
}

/** A Run's executing Job and its Job fan-out by kind. */
export async function listRunJobs(db: Database, code: string) {
  const runId = await resolveOrThrow(db, "run", code);
  return readJobs(db, runDemandWhere(runId), RUN_EXECUTE, {
    id: runId,
    shortcode: code,
  });
}

/** A record's single-item Jobs (image processing, location AI). */
export async function listSubjectJobs(
  db: Database,
  subject: { kind: JobSubjectEntity; id: string },
) {
  const recordId = await resolveOrThrow(db, subject.kind, subject.id);
  return readJobs(
    db,
    and(eq(job.subjectKind, subject.kind), eq(job.subjectId, recordId))!,
    null,
    null,
  );
}

/** One Job's identity and active window, for its log query. */
export async function readJobWindow(db: Database, id: string) {
  const [row] = await getDb(db)
    .select({
      id: job.id,
      runId: job.runId,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      state: job.state,
    })
    .from(job)
    .where(
      id.toUpperCase().startsWith("JOB-")
        ? eq(job.shortcode, id.toUpperCase())
        : eq(job.id, parseEntityId("job", id)),
    );
  return row ?? null;
}

import type { RunId } from "@cubby/schemas/identifiers";
import { jobState, type JobWaitReason } from "@cubby/schemas/job";
import { runStepMeta } from "@cubby/schemas/run-step";
import { scrubErrorMessage } from "@cubby/worker-tracing/scrub-error-message";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type {
  JobFacts,
  JobGroup,
  JobListOut,
  JobSubjectEntity,
} from "~/contracts/job.contract";
import { runStepPageSample } from "~/contracts/run-detail.contract";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { run, runStep } from "~/server/db/schema";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { evaluateBinding, limitEntries } from "../limits-catalog";
import { dueJobsAhead, type JobRow } from "./jobs";

/** The Job that executes any Run; other kinds are the Run's fan-out. */
const RUN_EXECUTE = "run.execute";

const iso = (date: Date | null) => date?.toISOString() ?? null;

const isDue = (row: JobRow, now: Date) =>
  (row.state === "queued" || row.state === "retry_wait") &&
  row.availableAt <= now;

async function facts(db: Database, row: JobRow, now: Date): Promise<JobFacts> {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    state: row.state,
    generation: row.generation,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    priority: row.priority,
    waitReason: row.waitReason,
    waitUntil: iso(row.waitUntil),
    availableAt: row.availableAt.toISOString(),
    leaseExpiresAt: iso(row.leaseExpiresAt),
    error: row.error === null ? null : scrubErrorMessage(row.error),
    cursor: row.cursor,
    subject:
      row.subjectKind && row.subjectId
        ? { kind: row.subjectKind, id: row.subjectId }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ahead: isDue(row, now) ? await dueJobsAhead(db, row.id) : null,
  };
}

/** Per-kind counts plus each kind's most recently touched Job. */
async function groupsOf(
  db: Database,
  owner: SQL,
  exclude: string | null,
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
  return Promise.all(
    latest.map(async (row) => {
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
        latest: await facts(db, row, now),
      };
    }),
  );
}

async function runningJobs(db: Database, now: Date) {
  const [row] = await getDb(db)
    .select({ count: count() })
    .from(job)
    .where(and(eq(job.state, "running"), gt(job.leaseExpiresAt, now)));
  return row?.count ?? 0;
}

async function activeAiRefreshRuns(db: Database) {
  const [row] = await getDb(db)
    .select({ count: count() })
    .from(run)
    .where(
      and(
        eq(run.purpose, "ai_refresh"),
        inArray(run.status, ["running", "paused", "paused_auth"]),
        sql`${run.deletedAt} IS NULL`,
      ),
    );
  return row?.count ?? 0;
}

/** The step a running Run is on, its last page's wall time and work sample. */
async function currentStep(db: Database, runId: RunId) {
  const [step] = await getDb(db)
    .select({ key: runStep.key, meta: runStep.meta })
    .from(runStep)
    .where(
      and(
        eq(runStep.runId, runId),
        inArray(runStep.state, ["running", "waiting", "paused"]),
      ),
    )
    .orderBy(asc(runStep.position))
    .limit(1);
  if (!step) return null;
  const meta = runStepMeta.partial().safeParse(step.meta ?? {});
  const page = z.object({ page: runStepPageSample }).safeParse(step.meta);
  return {
    key: step.key,
    lastPageMs: meta.success ? (meta.data.timing?.lastPageMs ?? null) : null,
    page: page.success ? page.data.page : null,
  };
}

async function readJobs(
  db: Database,
  owner: SQL,
  primaryKind: string | null,
  runId: RunId | null,
): Promise<JobListOut> {
  const now = new Date();
  const [primaryRow] = await getDb(db)
    .select()
    .from(job)
    .where(primaryKind ? and(owner, eq(job.kind, primaryKind)) : owner)
    .orderBy(desc(job.updatedAt))
    .limit(1);
  const [primary, groups, running, refreshRuns, step] = await Promise.all([
    primaryRow ? facts(db, primaryRow, now) : Promise.resolve(null),
    groupsOf(db, owner, primaryRow?.id ?? null, now),
    runningJobs(db, now),
    activeAiRefreshRuns(db),
    runId ? currentStep(db, runId) : Promise.resolve(null),
  ]);
  return {
    primary,
    groups,
    limits: limitEntries({
      runningJobs: running,
      activeAiRefreshRuns: refreshRuns,
      job: primaryRow ?? null,
      step,
    }),
    binding: evaluateBinding({
      job: primaryRow ? { ...primaryRow, ahead: primary?.ahead ?? null } : null,
      runningJobs: running,
      step,
      now,
    }),
  };
}

/** A Run's executing Job, its fan-out by kind, the limits and what binds now. */
export async function listRunJobs(db: Database, code: string) {
  const runId = await resolveOrThrow(db, "run", code);
  return readJobs(db, eq(job.runId, runId), RUN_EXECUTE, runId);
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
    .where(eq(job.id, id));
  return row ?? null;
}

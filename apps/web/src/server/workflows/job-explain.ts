import {
  emailShortcode,
  imageJobShortcode,
  runShortcode,
  jobShortcode,
  type RunId,
} from "@cubby/schemas/identifiers";
import { RUN_PURPOSE_LABEL, runPurpose } from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { JobFacts, RunRollup } from "~/contracts/job.contract";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { email, imageProcessingJob, run } from "~/server/db/schema";
import { imageJobDisplayStateSql } from "~/server/domains/image-processing/repo/image-job-state";
import { imageProcessingJobKey } from "~/server/domains/image-processing/repo/image-processing";
import { createAppError } from "~/server/errors/app-error";
import {
  jobFactsOf,
  readRunJobSamples,
  readRunRollups,
} from "~/server/generic/jobs/repo/job-queue";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";

type Step = {
  ref: string;
  kind: "run" | "imageJob" | "email" | "job";
  label: string;
  state: string;
  waitingOn: JobFacts["waitingOn"];
  detail: string | null;
};

/** Live Jobs shown under a Run: the oldest few of each waiting-on reason. */
const SAMPLES_PER_REASON = 2;

const jobStep = (facts: JobFacts): Step => ({
  ref: facts.id,
  kind: "job",
  label: `${facts.kind} · ${facts.key}`,
  state: facts.state,
  waitingOn: facts.waitingOn,
  detail: facts.error,
});

async function explainRun(
  db: Database,
  runId: RunId,
): Promise<{ steps: Step[]; rollup: RunRollup | null }> {
  const [owner] = await getDb(db)
    .select({
      id: run.id,
      shortcode: run.shortcode,
      purpose: run.purpose,
      status: run.status,
      failureCode: run.failureCode,
      dispatchError: run.dispatchError,
    })
    .from(run)
    .where(and(eq(run.id, runId), notDeleted(run)));
  if (!owner) throw createAppError("RUN_NOT_FOUND", "Run was not found");
  const rows = await readRunJobSamples(db, runId, SAMPLES_PER_REASON);
  const [facts, [rollup]] = await Promise.all([
    jobFactsOf(db, rows),
    readRunRollups(db, [owner]),
  ]);
  const executing = facts.find((entry) => entry.kind === "run.execute");
  const funding = rollup?.waitingForFunding ?? false;
  const runStep: Step = {
    ref: owner.shortcode,
    kind: "run",
    label: `${RUN_PURPOSE_LABEL[runPurpose.parse(owner.purpose)]} ${owner.shortcode}`,
    state: funding ? "paused: waiting for AI funding" : owner.status,
    waitingOn: funding
      ? { reason: "waiting_funding", lane: "frontier_ai", until: null }
      : (executing?.waitingOn ?? null),
    detail:
      [
        owner.failureCode,
        owner.dispatchError,
        rollup?.stalled
          ? `No Job progress for ${rollup.stallMinutes} min`
          : null,
      ]
        .filter(Boolean)
        .join("; ") || null,
  };
  return {
    steps: [
      runStep,
      ...facts
        .filter((entry) => entry.kind !== "run.execute" || entry.waitingOn)
        .map(jobStep),
    ],
    rollup: rollup ?? null,
  };
}

async function explainImageJob(db: Database, code: string) {
  const [row] = await getDb(db)
    .select({
      id: imageProcessingJob.id,
      shortcode: imageProcessingJob.shortcode,
      kind: imageProcessingJob.kind,
      state: imageJobDisplayStateSql(),
      lastError: imageProcessingJob.lastError,
      runId: imageProcessingJob.runId,
    })
    .from(imageProcessingJob)
    .where(eq(imageProcessingJob.shortcode, code));
  if (!row)
    throw createAppError("IMAGE_JOB_NOT_FOUND", "Image job was not found");
  const executions = await readJobs(db, { key: imageProcessingJobKey(row.id) });
  const [facts] = await jobFactsOf(db, executions);
  const steps: Step[] = [
    {
      ref: row.shortcode,
      kind: "imageJob",
      label: `${row.kind} ${row.shortcode}`,
      state: row.state,
      waitingOn: facts?.waitingOn ?? null,
      detail: row.lastError,
    },
    ...(facts ? [jobStep(facts)] : []),
  ];
  if (!row.runId) return { steps, rollup: null };
  const owner = await explainRun(db, row.runId);
  return { steps: [...steps, owner.steps[0]!], rollup: owner.rollup };
}

async function explainEmail(db: Database, code: string) {
  const [row] = await getDb(db)
    .select({
      shortcode: email.shortcode,
      status: email.status,
      subject: email.subject,
      runId: email.runId,
    })
    .from(email)
    .where(and(eq(email.shortcode, code), notDeleted(email)));
  if (!row) throw createAppError("EMAIL_NOT_FOUND", "Email was not found");
  const step: Step = {
    ref: row.shortcode,
    kind: "email",
    label: row.subject ?? row.shortcode,
    state: row.status,
    waitingOn: null,
    detail: row.runId ? null : "No Run owns this Email",
  };
  if (!row.runId) return { steps: [step], rollup: null };
  const owner = await explainRun(db, row.runId);
  return {
    steps: [{ ...step, waitingOn: owner.steps[0]!.waitingOn }, ...owner.steps],
    rollup: owner.rollup,
  };
}

async function explainJob(db: Database, id: string) {
  const rows = await readJobs(
    db,
    jobShortcode.safeParse(id).success ? { code: id } : { id },
  );
  const [facts] = await jobFactsOf(db, rows);
  if (!facts || !rows[0])
    throw createAppError("JOB_NOT_FOUND", "Job was not found");
  const steps: Step[] = [jobStep(facts)];
  if (!rows[0].runId) return { steps, rollup: null };
  const owner = await explainRun(db, rows[0].runId);
  return { steps: [...steps, owner.steps[0]!], rollup: owner.rollup };
}

/**
 * The waiting-on chain for a Run, image job, Email or Job: from the record
 * through its owner to the Jobs that hold it, each with the same derived
 * waiting-on every client reads.
 */
export async function explainWaiting(db: Database, raw: string) {
  const id = raw.trim();
  if (z.uuid().safeParse(id).success) return explainJob(db, id);
  const upper = id.toUpperCase();
  if (jobShortcode.safeParse(upper).success) return explainJob(db, upper);
  const runCode = runShortcode.safeParse(upper);
  if (runCode.success) {
    const [owner] = await getDb(db)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.shortcode, runCode.data));
    if (!owner) throw createAppError("RUN_NOT_FOUND", "Run was not found");
    return explainRun(db, owner.id);
  }
  const imageJobCode = imageJobShortcode.safeParse(upper);
  if (imageJobCode.success) return explainImageJob(db, imageJobCode.data);
  const emailCode = emailShortcode.safeParse(upper);
  if (emailCode.success) return explainEmail(db, emailCode.data);
  throw createAppError(
    "EXPLAIN_TARGET_UNSUPPORTED",
    "Explain takes a RUN-, IPR- or EML- code or a Job id",
  );
}

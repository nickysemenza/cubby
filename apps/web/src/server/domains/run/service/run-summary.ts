/**
 * The AI summary of an ended Run: what it did and what is left for a member,
 * written once per end generation (`endedAt`) for Runs in the default Runs
 * list that ended after `RUN_SUMMARY_CUTOFF`.
 *
 * Admission is a plain drain over owed Runs; each Run end is one keyed
 * `run-ai.summary.write` Job, so the Job owns claim, lease, retry and
 * backoff, and an exhausted Job keeps its Run from being owed again. The model
 * call itself is the kernel Ask `runSummaryAsk`; when its outcome is unknown,
 * the Run's machinery asks the member and the `run.summary` pass finishes the
 * summary once they answer, so the Job completes instead of failing.
 * The summarized Run is never the call's owner: the call is automatic AI work,
 * so a funding stop throws into the Job instead of pausing the Run, and the
 * handler writes only `AiAnalysis`.
 */
import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import { runEntityId } from "@cubby/schemas/identifiers";
import { z } from "zod";

import { AUTOMATIC_AI_CALL } from "~/server/ai/policy/call-owner";
import { RUN_SUMMARY_FEATURE } from "~/server/ai/policy/features";
import { upsertAiAnalysis } from "~/server/ai/repo/ai-analysis";
import { runStructuredFeature } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import type { Fenced } from "~/server/generic/jobs/types";
import {
  AskAbandonedError,
  AskUnknownError,
  defineAsk,
  defineModule,
  definePass,
  startPass,
  withAsk,
} from "~/server/kernel/api";
import { WORKFLOW_PASSES } from "~/server/workflows/kernel-passes";

import { readRunById } from "../repo/run";
import { listRunStepsForRuns } from "../repo/run-step";
import {
  listOwedRunSummaries,
  runEndedAtGeneration,
  runSummaryDueSql,
} from "../repo/run-summary";

const PAGE = 20;

const jsonValue = z.json();

/**
 * The Run summary as a kernel Ask: its declared input is the Run's composed
 * words and counts, and the call goes through funding admission, the
 * response cache's in-flight claim and a committed Answer.
 */
const runSummaryAsk = defineAsk({
  feature: RUN_SUMMARY_FEATURE.feature,
  producer: "model",
  promptVersion: RUN_SUMMARY_FEATURE.promptVersion,
  input: jsonValue,
  output: RUN_SUMMARY_FEATURE.schema,
  policy: { tier: RUN_SUMMARY_FEATURE.tier },
  label: "a Run summary",
  async produce(input, { db }) {
    let model: string | null = null;
    const output = await runStructuredFeature(
      RUN_SUMMARY_FEATURE,
      RUN_SUMMARY_FEATURE.request(input),
      {
        db,
        ...AUTOMATIC_AI_CALL,
        operation: "runSummary",
        applicationCache: false,
        onAnswered: (answered) => {
          model = answered;
        },
      },
    );
    return { output, model, tier: RUN_SUMMARY_FEATURE.tier };
  },
});

const RUN_SUMMARY_PASS = "run.summary";
const runSummaryTask = z.object({
  subjectRunId: z.string(),
  endedAt: z.string(),
});
const passKey = (task: z.infer<typeof runSummaryTask>) =>
  `${task.subjectRunId}:${task.endedAt}`;
/** A Run summary whose answer is unknown, waiting for the member's word on it. */
const MEMBER_WAIT_MS = 6 * 60 * 60_000;

/**
 * Continues a summary whose model call went out with an unknown outcome. The
 * ask waits for the member (the Run's machinery shows it); when they mark it
 * not sent or give up, the ask settles and this pass runs at once.
 */
const runSummaryPass = definePass({
  name: RUN_SUMMARY_PASS,
  async run(db, cursor, claim) {
    const task = runSummaryTask.parse(cursor);
    try {
      await summarize(db, task, claim.fenced);
      return { cursor, done: true };
    } catch (error) {
      if (error instanceof AskAbandonedError) return { cursor, done: true };
      if (error instanceof AskUnknownError)
        return {
          cursor,
          done: false,
          availableAt: new Date(Date.now() + MEMBER_WAIT_MS),
        };
      throw error;
    }
  },
});

export const runKernelModule = defineModule({
  name: "run",
  asks: [runSummaryAsk],
  passes: [runSummaryPass, ...WORKFLOW_PASSES],
  // A Run shows the asks it waits on directly (its summary) in its machinery.
  machinery: [{ entity: "run", owning: null, fields: false, quality: false }],
});

/**
 * Publishes one summary Job per owed Run end. Concurrent pages publish the
 * same keys, which the Job key dedupes.
 */
export const runSummaryDrain: BackgroundDrain = {
  name: "run-summary",
  label: (unit) => (unit === "run-summary" ? "Run summaries" : undefined),
  due: runSummaryDueSql,
  next: () => null,
  async page(db) {
    const owed = await listOwedRunSummaries(db, PAGE);
    const tasks = owed.map((entry): BackgroundTaskInput => ({
      kind: "run-ai.summary.write",
      requestedAt: new Date().toISOString(),
      ...entry,
    }));
    if (tasks.length) {
      const { publishInBackground } =
        await import("~/server/workflows/background-tasks/publish");
      await publishInBackground(db, tasks, { source: "run-summary" });
    }
    return { claimed: tasks.length };
  },
};

/**
 * Write the summary of `subjectRunId`'s end `endedAt`. Skips a Run that was
 * restarted, re-ended or removed since admission; a provider or funding error
 * throws so the Job records the attempt and retries.
 */
export async function writeRunSummary(
  db: Database,
  task: { subjectRunId: string; endedAt: string },
  fenced: Fenced,
): Promise<"succeeded" | "skipped"> {
  try {
    return await summarize(db, task, fenced);
  } catch (error) {
    // An unknown call waits for the member instead of failing this Job; the
    // pass finishes the summary once they settle the ask.
    if (error instanceof AskUnknownError) {
      await startPass(db, runSummaryPass, { key: passKey(task), cursor: task });
      return "skipped";
    }
    if (error instanceof AskAbandonedError) return "skipped";
    throw error;
  }
}

async function summarize(
  db: Database,
  task: { subjectRunId: string; endedAt: string },
  fenced: Fenced,
): Promise<"succeeded" | "skipped"> {
  const runId = runEntityId.parse(task.subjectRunId);
  if (!(await runEndedAtGeneration(db, runId, task.endedAt))) return "skipped";
  const [record, steps] = await Promise.all([
    readRunById(db, runId),
    listRunStepsForRuns(db, [runId]),
  ]);
  // The Run's own composed words and counts; never Email bodies or transcripts.
  const input = {
    kind: record.purpose,
    title: record.displayName,
    why: record.whyLine?.title ?? "Cause not recorded",
    outcome: record.outcomeLine,
    state: record.displayStatus,
    stateReason: record.stateReason,
    wallTime: record.wallTime,
    failure: record.failureCode,
    steps: steps.slice(0, 20).map((step) => ({
      label: step.label,
      state: step.state,
      done: step.done,
      failed: step.failed,
      skipped: step.skipped,
      seconds:
        step.startedAt && step.endedAt
          ? Math.round(
              (step.endedAt.getTime() - step.startedAt.getTime()) / 1000,
            )
          : null,
    })),
  };
  // The Answer is committed before the summary is written; a retry of this
  // Job reads it instead of calling again.
  const { text } = await withAsk(
    db,
    runSummaryAsk,
    jsonValue.parse(JSON.parse(JSON.stringify(input))),
    {
      record: { entity: "run", id: runId },
      pass: { name: RUN_SUMMARY_PASS, key: passKey(task) },
    },
  );
  let written = false;
  await fenced(async (tx) => {
    // A Run that changed generation since the call is left without a summary.
    if (!(await runEndedAtGeneration(tx, runId, task.endedAt, true))) return;
    await upsertAiAnalysis(
      tx,
      {
        entityKind: "run",
        entityId: runId,
        feature: RUN_SUMMARY_FEATURE,
        inputFingerprint: await fingerprint({ runId, ...task, input }),
      },
      { text, generation: task.endedAt },
    );
    written = true;
  });
  return written ? "succeeded" : "skipped";
}

async function fingerprint(value: unknown) {
  const bytes = new TextEncoder().encode(
    JSON.stringify([RUN_SUMMARY_FEATURE.promptVersion, value]),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

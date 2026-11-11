/**
 * The AI summary of an ended Run: what it did and what is left for a member,
 * written once per end generation (`endedAt`) for Runs in the default Runs
 * list that ended after `RUN_SUMMARY_CUTOFF`.
 *
 * Admission is a plain drain over owed Runs; each Run end is one keyed
 * `run-ai.summary.write` Job, so the Job owns claim, lease, provider fence,
 * retry and backoff, and an exhausted Job keeps its Run from being owed again.
 * The summarized Run is never the call's owner: the call is automatic AI work,
 * so a funding stop throws into the Job instead of pausing the Run, and the
 * handler writes only `AiAnalysis`.
 */
import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import { runEntityId } from "@cubby/schemas/identifiers";

import { AUTOMATIC_AI_CALL } from "~/server/ai/policy/call-owner";
import { RUN_SUMMARY_FEATURE } from "~/server/ai/policy/features";
import { upsertAiAnalysis } from "~/server/ai/repo/ai-analysis";
import { runStructuredFeature } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import type { Fenced } from "~/server/generic/jobs/types";

import { readRunById } from "../repo/run";
import { listRunStepsForRuns } from "../repo/run-step";
import {
  listOwedRunSummaries,
  runEndedAtGeneration,
  runSummaryDueSql,
} from "../repo/run-summary";

const PAGE = 20;

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
  const { text } = await runStructuredFeature(
    RUN_SUMMARY_FEATURE,
    RUN_SUMMARY_FEATURE.request(input),
    {
      db,
      ...AUTOMATIC_AI_CALL,
      operation: "runSummary",
      entity: { entityKind: "run", entityId: runId },
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

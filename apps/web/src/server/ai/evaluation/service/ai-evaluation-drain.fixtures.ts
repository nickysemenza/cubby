import {
  claimAiEvaluation,
  type ClaimedAiEvaluation,
} from "~/server/ai/evaluation/repo/ai-evaluation";
import { AI_EVALUATION_TARGET } from "~/server/ai/evaluation/repo/ai-evaluation-work";
import type { Database } from "~/server/db";
import {
  runAiEvaluationExecution,
  type AiEvaluationPorts,
} from "~/server/domains/run/service/ai-evaluation-execution";
import { updateJobs } from "~/server/generic/jobs/jobs.fixtures";
import { readJob } from "~/server/generic/jobs/repo/job-reads";
import { wakeJob } from "~/server/generic/jobs/repo/producer";
import {
  postponeWorkRefs,
  workItemStates,
} from "~/server/generic/jobs/repo/work-items";
import {
  advanceJob,
  type JobOutcome,
} from "~/server/generic/jobs/service/jobs";
import { withJobFixtureExecution } from "~/server/testing/background-queue";

import { aiEvaluationJobHandler } from "./ai-evaluation-drain";

/**
 * Run the real drain pages holding these evaluations, substituting only
 * provider ports and short waits (item backoff and Job waits end now). Stops
 * at the first page that does not succeed, leaving its items for inspection.
 * Without `pages` it drains until no item remains; with it, it stops after
 * that many pages (each one retries due items immediately).
 */
export async function drainAiEvaluations(
  db: Database,
  ids: readonly string[],
  ports: AiEvaluationPorts = {},
  { pages }: { pages?: number } = {},
): Promise<JobOutcome[]> {
  const handlers = {
    "ai.evaluation": aiEvaluationJobHandler(runAiEvaluationExecution(ports)),
  };
  const outcomes: JobOutcome[] = [];
  for (let page = 0; page < (pages ?? 20); page++) {
    const drains = await postponeWorkRefs(
      db,
      AI_EVALUATION_TARGET,
      ids,
      new Date(),
    );
    if (!drains.length) return outcomes;
    for (const key of drains) {
      await wakeJob(db, { key, kind: "ai.evaluation", input: {} });
      await updateJobs(
        db,
        { key, states: ["queued", "retry_wait"] },
        { availableAt: new Date(0), waitReason: null, waitUntil: null },
      );
      const execution = await readJob(db, { key });
      if (!execution) throw new Error(`Synthetic drain ${key} is missing`);
      const outcome = await advanceJob(db, execution.id, handlers);
      outcomes.push(outcome);
      if (outcome !== "succeeded") return outcomes;
    }
  }
  if (pages) return outcomes;
  throw new Error("AI evaluation drain exceeded 20 pages");
}

/** The evaluation's drain item, or undefined once it settled or parked. */
export async function aiEvaluationItem(db: Database, id: string) {
  const [item] = await workItemStates(db, AI_EVALUATION_TARGET, [id]);
  return item;
}

/**
 * Claim the evaluation inside its drain Job and run `work` with the attempt,
 * as the single-item drain does; the drain claim is released afterwards.
 */
export async function withClaimedAiEvaluation<T>(
  db: Database,
  id: string,
  work: (claimed: ClaimedAiEvaluation) => Promise<T>,
) {
  const item = await aiEvaluationItem(db, id);
  if (!item) throw new Error(`Synthetic evaluation ${id} has no drain item`);
  return withJobFixtureExecution(
    db,
    { key: item.drain, kind: "ai.evaluation", input: {} },
    async (context) => {
      const claimed = await claimAiEvaluation(context, item);
      if (!claimed) throw new Error(`Synthetic evaluation ${id} is settled`);
      return work(claimed);
    },
    { releaseClaim: true },
  );
}

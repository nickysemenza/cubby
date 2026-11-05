import { eq, inArray, isNotNull, and } from "drizzle-orm";

import {
  claimAiEvaluation,
  type ClaimedAiEvaluation,
} from "~/server/ai/evaluation/repo/ai-evaluation";
import {
  aiEvaluationPageKey,
  aiEvaluationStore,
  releaseAiEvaluationPage,
} from "~/server/ai/evaluation/repo/ai-evaluation-work";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation } from "~/server/db/schema";
import {
  runAiEvaluationExecution,
  type AiEvaluationPorts,
} from "~/server/domains/run/service/ai-evaluation-execution";
import { outsideJob } from "~/server/generic/jobs/outside-job";

import {
  runAiEvaluationPage,
  type AiEvaluationPageOutcome,
} from "./ai-evaluation-drain";

/**
 * Run the real pages holding these evaluations, substituting only provider ports
 * and short waits (item backoff and feature waits end now). Stops at the first
 * page that does not succeed, leaving its rows for inspection. Without `pages` it
 * drains until nothing is owed; with it, it stops after that many pages (each one
 * retries due rows immediately).
 */
export async function drainAiEvaluations(
  db: Database,
  ids: readonly string[],
  ports: AiEvaluationPorts = {},
  { pages }: { pages?: number } = {},
): Promise<AiEvaluationPageOutcome[]> {
  const execution = runAiEvaluationExecution(ports);
  const outcomes: AiEvaluationPageOutcome[] = [];
  for (let page = 0; page < (pages ?? 20); page++) {
    // Force due independently of the test host and PostgreSQL clocks.
    const owed = await getDb(db)
      .update(aiEvaluation)
      .set({ runAt: new Date(0), waitCause: null })
      .where(
        and(inArray(aiEvaluation.id, [...ids]), isNotNull(aiEvaluation.runAt)),
      )
      .returning({ feature: aiEvaluation.feature });
    if (!owed.length) return outcomes;
    for (const feature of [...new Set(owed.map((row) => row.feature))].sort()) {
      const { outcome } = await runAiEvaluationPage(db, execution, feature);
      outcomes.push(outcome);
      if (outcome !== "succeeded") return outcomes;
    }
  }
  if (pages) return outcomes;
  throw new Error("AI evaluation drain exceeded 20 pages");
}

/** What the drain still owes for the evaluation, or undefined once it settled or parked. */
export async function aiEvaluationItem(db: Database, id: string) {
  const [row] = await getDb(db)
    .select({
      ref: aiEvaluation.id,
      feature: aiEvaluation.feature,
      priority: aiEvaluation.priority,
      attempts: aiEvaluation.attempts,
      readyAt: aiEvaluation.runAt,
      lastError: aiEvaluation.error,
      waitCause: aiEvaluation.waitCause,
    })
    .from(aiEvaluation)
    .where(and(eq(aiEvaluation.id, id), isNotNull(aiEvaluation.runAt)));
  return row;
}

/**
 * Claim the evaluation under a fresh page lease and run `work` with the attempt,
 * as the single-item drain does; the lease is released afterwards.
 */
export async function withClaimedAiEvaluation<T>(
  db: Database,
  id: string,
  work: (claimed: ClaimedAiEvaluation) => Promise<T>,
) {
  const owed = await aiEvaluationItem(db, id);
  if (!owed) throw new Error(`Synthetic evaluation ${id} is not owed`);
  const token = crypto.randomUUID();
  await getDb(db)
    .update(aiEvaluation)
    .set({ runAt: new Date(0) })
    .where(eq(aiEvaluation.id, id));
  const store = aiEvaluationStore(owed.feature, token);
  const items = await store.claim(db, 1_000);
  const item = items.find((entry) => entry.ref === id);
  if (!item) throw new Error(`Synthetic evaluation ${id} could not be claimed`);
  try {
    const claimed = await claimAiEvaluation(
      {
        claim: {
          key: aiEvaluationPageKey(owed.feature),
          generation: 1,
          leaseToken: token,
        },
        fenced: outsideJob(db),
      },
      item,
    );
    if (!claimed) throw new Error(`Synthetic evaluation ${id} is settled`);
    return await work(claimed);
  } finally {
    await releaseAiEvaluationPage(db, token);
  }
}

/** Put an owed evaluation where an earlier page would have left it. */
export const updateAiEvaluationWork = (
  db: Database,
  ids: readonly string[],
  set: {
    attempts?: number;
    error?: string;
    priority?: number;
    runAt?: Date;
  },
) =>
  getDb(db)
    .update(aiEvaluation)
    .set(set)
    .where(inArray(aiEvaluation.id, [...ids]));

/** How many evaluations the drain owes. */
export const owedAiEvaluations = async (db: Database) =>
  (
    await getDb(db)
      .select({ id: aiEvaluation.id })
      .from(aiEvaluation)
      .where(isNotNull(aiEvaluation.runAt))
  ).length;

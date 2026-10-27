import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  claimAiEvaluation,
  type ClaimedAiEvaluation,
} from "~/server/ai/repo/ai-evaluation";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { job } from "~/server/db/retained-tables";
import { wakeJob } from "~/server/generic/jobs/repo/producer";
import {
  advanceJob,
  type JobOutcome,
} from "~/server/generic/jobs/service/jobs";
import { withJobFixtureExecution } from "~/server/testing/background-queue";

import {
  aiEvaluationJobHandler,
  type AiEvaluationPorts,
} from "./ai-evaluation-drain";

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
  const handlers = { "ai.evaluation": aiEvaluationJobHandler(ports) };
  const outcomes: JobOutcome[] = [];
  for (let page = 0; page < (pages ?? 20); page++) {
    const due = await getDb(db).execute(sql`
      UPDATE "WorkItem" SET "readyAt" = now()
       WHERE target = 'ai.evaluation' AND ref = ANY(${uuidArrayParam(ids)})
      RETURNING drain`);
    const drains = [
      ...new Set(
        z
          .array(z.object({ drain: z.string() }))
          .parse(due.rows)
          .map((row) => row.drain),
      ),
    ].sort();
    if (!drains.length) return outcomes;
    for (const key of drains) {
      await wakeJob(db, { key, kind: "ai.evaluation", input: {} });
      await getDb(db)
        .update(job)
        .set({ availableAt: new Date(0), waitReason: null, waitUntil: null })
        .where(
          and(eq(job.key, key), inArray(job.state, ["queued", "retry_wait"])),
        );
      const [execution] = await getDb(db)
        .select({ id: job.id })
        .from(job)
        .where(eq(job.key, key));
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
  const result = await getDb(db).execute(sql`
    SELECT drain, priority, attempts, "lastError", "readyAt" FROM "WorkItem"
     WHERE target = 'ai.evaluation' AND ref = ${id}::uuid`);
  return z
    .array(
      z.object({
        drain: z.string(),
        priority: z.coerce.number(),
        attempts: z.coerce.number(),
        lastError: z.string().nullable(),
        readyAt: z.coerce.date(),
      }),
    )
    .parse(result.rows)[0];
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
  const result = await getDb(db).execute(sql`
    SELECT drain, target, ref::text AS ref, ticket, priority, attempts
      FROM "WorkItem" WHERE target = 'ai.evaluation' AND ref = ${id}::uuid`);
  const [item] = z
    .array(
      z.object({
        drain: z.string(),
        target: z.string(),
        ref: z.string(),
        ticket: z.coerce.number(),
        priority: z.coerce.number(),
        attempts: z.coerce.number(),
      }),
    )
    .parse(result.rows);
  if (!item) throw new Error(`Synthetic evaluation ${id} has no drain item`);
  return withJobFixtureExecution(
    db,
    { key: item.drain, kind: "ai.evaluation", input: {} },
    async () => {
      const claimed = await claimAiEvaluation(db, item);
      if (!claimed) throw new Error(`Synthetic evaluation ${id} is settled`);
      return work(claimed);
    },
    { releaseClaim: true },
  );
}

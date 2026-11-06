import {
  advanceStepRun,
  type StepPlan,
} from "~/server/domains/run/service/step-run";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import type { JobHandlers } from "~/server/generic/jobs/types";
import { updateJobs } from "~/server/generic/jobs/jobs.fixtures";
import { readJob } from "~/server/generic/jobs/repo/job-reads";
import { pauseJob } from "~/server/generic/jobs/repo/operator";
import { postponeAiEvaluationWork } from "~/server/ai/evaluation/repo/ai-evaluation-work";
import type { RunId } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { run, runStep } from "~/server/db/schema";
import { getDb } from "~/server/db/helpers";
import {
  advanceAiWorkRun,
  aiWorkItems,
  type AiWorkPorts,
} from "~/server/domains/run/service/ai-work";
import { runAiEvaluationPage } from "~/server/ai/evaluation/service/ai-evaluation-drain";
import { runAiEvaluationExecution } from "~/server/domains/run/service/ai-evaluation-execution";
import { reclassifyEmails } from "~/server/domains/purchase-import/service/gmail/reclassify";
import { loadMailReclassificationRead } from "~/server/domains/run/repo/run-reclassification-read";
import { emailReclassifyResults } from "@cubby/schemas/email-actions";
import type { z } from "zod";

export async function reclassifyForTest(
  ...args: Parameters<typeof reclassifyEmails>
) {
  const [db, input, actor, ports] = args;
  const submitted = await reclassifyEmails(db, input, actor, {
    ...ports,
  });
  const results: z.infer<typeof emailReclassifyResults> = [];
  for (const code of submitted.runIds) {
    const [owner] = await getDb(db)
      .select()
      .from(run)
      .where(eq(run.shortcode, code));
    if (!owner?.ledgerPartyId)
      throw new Error("Synthetic reclassification owner is missing");
    await driveAiWork(db, owner.id, { reclassification: ports });
    const read = await loadMailReclassificationRead(db, code, {
      userId: actor.userId,
      ledgerPartyId: owner.ledgerPartyId,
    });
    results.push(...(read?.receipts?.results ?? []));
  }
  results.sort(
    (left, right) => input.ids.indexOf(left.id) - input.ids.indexOf(right.id),
  );
  return { ...submitted, results };
}

/** Use real Job claims and publication, substituting only provider seams and short waits. */
export async function driveAiWork(
  db: Database,
  id: RunId,
  ports: AiWorkPorts = {},
  plan?: StepPlan,
) {
  const handlers: JobHandlers = {
    "run.execute": {
      prepare: async (database, claim) => {
        const [owner] = await getDb(database)
          .select({ purpose: run.purpose })
          .from(run)
          .where(eq(run.id, id));
        if (owner?.purpose === "sweep") {
          // Advance persisted step waits alongside the Job's synthetic clock.
          await getDb(database)
            .update(runStep)
            .set({ meta: sql`${runStep.meta} - 'capacityUntil'` })
            .where(eq(runStep.runId, id));
          const result = await advanceStepRun(
            database,
            { runId: id, attempt: claim.generation },
            plan,
          );
          return {
            page: {
              done: result.kind === "finished" || result.kind === "lost",
            },
          };
        }
        const pending = await advanceAiWorkRun(database, {
          runId: id,
          attempt: claim.generation,
        });
        return { page: { done: !pending } };
      },
    },
  };
  for (let cycle = 0; cycle < 205; cycle++) {
    const execution = await readJob(db, { key: `run:${id}` });
    if (!execution) throw new Error("Synthetic Run execution is missing");
    if (
      ["completed", "failed", "paused", "cancelled"].includes(execution.state)
    )
      return;
    await updateJobs(
      db,
      { id: execution.id, states: ["queued", "retry_wait"] },
      { availableAt: new Date(0) },
    );
    await advanceJob(db, execution.id, handlers);
    const [owner] = await getDb(db).select().from(run).where(eq(run.id, id));
    if (!owner) return;
    const items = await aiWorkItems(db, owner);
    const pending = items.filter((item) =>
      ["queued", "result_ready"].includes(item.state),
    );
    // Short waits only: due items and their drains run now. A pause point
    // releases only the items before it, since one page claims several.
    const released =
      ports.sweep?.pauseAfter === undefined
        ? pending
        : pending.slice(
            0,
            Math.max(
              0,
              ports.sweep.pauseAfter - (items.length - pending.length),
            ),
          );
    await postponeAiEvaluationWork(
      db,
      pending.map((item) => item.id),
      new Date(Date.now() + 60 * 60_000),
    );
    await postponeAiEvaluationWork(
      db,
      released.map((item) => item.id),
      new Date(0),
    );
    for (const feature of new Set(released.map((item) => item.feature))) {
      const { outcome } = await runAiEvaluationPage(
        db,
        runAiEvaluationExecution(ports),
        feature,
      );
      if (["superseded", "deferred"].includes(outcome)) return;
      if (ports.sweep?.pauseAfter !== undefined) {
        const done = (await aiWorkItems(db, owner)).filter(
          (item) => !["queued", "result_ready"].includes(item.state),
        ).length;
        if (done >= ports.sweep.pauseAfter) {
          await pauseJob(db, execution.id);
          await getDb(db)
            .update(run)
            .set({ status: "paused" })
            .where(and(eq(run.id, id), eq(run.status, "running")));
          return;
        }
      }
    }
    if (owner.status === "paused_auth") return;
  }
  throw new Error("Synthetic AI work did not settle within its bounded pages");
}

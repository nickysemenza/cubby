import { job } from "~/server/db/retained-tables";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import type { JobHandlers } from "~/server/generic/jobs/types";
import { pauseJob } from "~/server/generic/jobs/repo/operator";
import { aiEvaluationJobInput } from "~/server/generic/jobs/inputs";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import type { RunId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { aiEvaluation, run } from "~/server/db/schema";
import { getDb } from "~/server/db/helpers";
import {
  advanceAiWorkRun,
  aiWorkItems,
  executeAiWorkTarget,
  type AiWorkPorts,
} from "~/server/domains/run/service/ai-work";
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
) {
  const handlers: JobHandlers = {
    "run.execute": {
      prepare: async (database, claim) => {
        const pending = await advanceAiWorkRun(
          database,
          { runId: id, attempt: claim.generation },
          ports,
        );
        return { page: { done: !pending?.length } };
      },
    },
    "ai.evaluation": {
      prepare: async (database, claim) => {
        const { evaluationId } = aiEvaluationJobInput.parse(claim.input);
        const [item] = await getDb(database)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, evaluationId));
        if (!item) throw new Error("Synthetic AI evaluation is missing");
        const [owner] = await getDb(database)
          .select()
          .from(run)
          .where(eq(run.id, item.runId));
        if (
          owner?.status === "paused_auth" &&
          owner.failureCode === "execution_limit"
        )
          await getDb(database)
            .update(run)
            .set({ status: "running" })
            .where(eq(run.id, item.runId));
        await executeAiWorkTarget(database, evaluationId, id, ports);
        const [settled] = await getDb(database)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, evaluationId));
        if (settled?.state === "failed")
          throw new Error(settled.error ?? "Synthetic AI target failed");
        if (
          settled &&
          ["queued", "running", "retry_wait", "result_ready"].includes(
            settled.state,
          )
        )
          throw new JobDeferredError(
            settled.error ?? "Synthetic evidence continuation",
            new Date(Date.now() + 1),
            "provider_capacity",
          );
        return { page: { done: true } };
      },
    },
  };
  for (let cycle = 0; cycle < 205; cycle++) {
    const [execution] = await getDb(db)
      .select()
      .from(job)
      .where(eq(job.key, `run:${id}`));
    if (!execution) throw new Error("Synthetic Run execution is missing");
    if (
      ["completed", "failed", "paused", "cancelled"].includes(execution.state)
    )
      return;
    await getDb(db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(
        and(
          eq(job.id, execution.id),
          inArray(job.state, ["queued", "retry_wait"]),
        ),
      );
    await advanceJob(db, execution.id, handlers);
    const [owner] = await getDb(db).select().from(run).where(eq(run.id, id));
    if (!owner) return;
    const items = await aiWorkItems(db, owner);
    for (const item of items.filter((item) =>
      ["queued", "running", "retry_wait", "result_ready"].includes(item.state),
    )) {
      const [target] = await getDb(db)
        .select()
        .from(job)
        .where(eq(job.key, `ai-evaluation:${item.id}`));
      if (
        !target ||
        ["paused", "failed", "cancelled", "completed"].includes(target.state)
      )
        continue;
      if (
        target.availableAt.getTime() > Date.now() &&
        owner.status === "paused_auth"
      )
        return;
      await getDb(db)
        .update(job)
        .set({ availableAt: new Date(0) })
        .where(
          and(
            eq(job.id, target.id),
            inArray(job.state, ["queued", "retry_wait"]),
          ),
        );
      const outcome = await advanceJob(db, target.id, handlers);
      if (["superseded", "paused", "deferred"].includes(outcome)) return;
      if (ports.sweep?.pauseAfter !== undefined) {
        const done = (await aiWorkItems(db, owner)).filter(
          (item) =>
            !["queued", "running", "result_ready", "retry_wait"].includes(
              item.state,
            ),
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

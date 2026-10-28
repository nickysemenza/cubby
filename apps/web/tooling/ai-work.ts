import { job } from "~/server/db/retained-tables";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import type { JobHandlers } from "~/server/generic/jobs/types";
import { pauseJob } from "~/server/generic/jobs/repo/operator";
import { postponeWorkRefs } from "~/server/generic/jobs/repo/work-items";
import { AI_EVALUATION_TARGET } from "~/server/ai/evaluation/repo/ai-evaluation-work";
import type { RunId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { run } from "~/server/db/schema";
import { getDb } from "~/server/db/helpers";
import {
  advanceAiWorkRun,
  aiWorkItems,
  type AiWorkPorts,
} from "~/server/domains/run/service/ai-work";
import { aiEvaluationJobHandler } from "~/server/ai/evaluation/service/ai-evaluation-drain";
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
    "ai.evaluation": aiEvaluationJobHandler(runAiEvaluationExecution(ports)),
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
    const drains = await postponeWorkRefs(
      db,
      AI_EVALUATION_TARGET,
      pending.map((item) => item.id),
      new Date(Date.now() + 60 * 60_000),
    );
    await postponeWorkRefs(
      db,
      AI_EVALUATION_TARGET,
      released.map((item) => item.id),
      new Date(),
    );
    for (const key of drains) {
      const [target] = await getDb(db)
        .select()
        .from(job)
        .where(eq(job.key, key));
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
        .set({ availableAt: new Date(0), waitUntil: null, waitReason: null })
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

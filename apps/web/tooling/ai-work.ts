import type { RunId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { aiEvaluation, run } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  advanceAiWorkRun,
  aiWorkItems,
  executeAiWorkTarget,
  type AiWorkPorts,
} from "~/server/runs/ai-work";
import {
  failWorkflowRun,
  runFailureText,
} from "~/server/workflow-runs/lifecycle";
import type { WorkflowLauncher } from "~/server/workflow-runs/launcher";
import { reclassifyEmails } from "~/server/purchase-import/gmail/reclassify";
import { loadMailReclassificationRead } from "~/server/repo/run-reclassification-read";
import { emailReclassifyResults } from "@cubby/schemas/email-actions";
import type { z } from "zod";

export const TEST_AI_WORK_LAUNCHER: WorkflowLauncher = {
  create: async () => {},
  terminate: async () => {},
  status: async () => ({ state: "running", error: null }),
};

export async function reclassifyForTest(
  ...args: Parameters<typeof reclassifyEmails>
) {
  const [db, input, actor, ports] = args;
  const submitted = await reclassifyEmails(db, input, actor, {
    ...ports,
    launcher: TEST_AI_WORK_LAUNCHER,
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

/** Replace only Cloudflare delivery and elapsed retry time; execute real persisted transitions. */
export async function driveAiWork(
  db: Database,
  id: RunId,
  ports: AiWorkPorts = {},
) {
  const [owner] = await getDb(db).select().from(run).where(eq(run.id, id));
  const attempt =
    owner?.progress &&
    "attempt" in owner.progress &&
    typeof owner.progress.attempt === "number"
      ? owner.progress.attempt
      : 0;
  try {
    for (let cycle = 0; cycle < 205; cycle++) {
      const pending = await advanceAiWorkRun(db, { runId: id, attempt });
      if (!pending?.length) return;
      for (const item of pending) {
        if (item.state === "retry_wait")
          await getDb(db)
            .update(aiEvaluation)
            .set({ nextAttemptAt: new Date(0) })
            .where(
              and(
                eq(aiEvaluation.id, item.id),
                eq(aiEvaluation.state, "retry_wait"),
              ),
            );
        await executeAiWorkTarget(db, item.id, id, {
          ...ports,
          launcher: TEST_AI_WORK_LAUNCHER,
        });
        if (ports.sweep?.pauseAfter !== undefined && owner) {
          const done = (await aiWorkItems(db, owner)).filter(
            (row) =>
              !["queued", "running", "result_ready", "retry_wait"].includes(
                row.state,
              ),
          ).length;
          if (done >= ports.sweep.pauseAfter) {
            await advanceAiWorkRun(db, { runId: id, attempt });
            await getDb(db)
              .update(run)
              .set({ status: "paused" })
              .where(and(eq(run.id, id), eq(run.status, "running")));
            return;
          }
        }
      }
    }
    throw new Error(
      "Synthetic AI work did not settle within its bounded retries",
    );
  } catch (error) {
    await failWorkflowRun(
      db,
      { runId: id, attempt },
      {
        failureCode: "ai_work_workflow_failed",
        message: runFailureText(error instanceof Error ? error : String(error)),
      },
    );
    throw error;
  }
}

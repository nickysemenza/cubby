import { mailReclassificationCheckpoint } from "@cubby/schemas/email-actions";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";

import type { Database } from "~/server/db";
import {
  type ReclassificationPorts,
  executeReclassificationTarget,
} from "~/server/domains/purchase-import/service/gmail/reclassification-target";
import { writeRunningAttemptProgress } from "~/server/domains/run/repo/ai-work-state";
import type { WorkflowRunParams } from "~/server/workflows/runs/contract";
import { claimWorkflowRun } from "~/server/workflows/runs/lifecycle";

export type AiWorkPorts = {
  reclassification?: ReclassificationPorts;
  sweep?: import("./suggestion-sweep").SuggestionSweepPorts;
};

/** One captured Email per page; model Answers and the Run checkpoint survive retries. */
export async function advanceAiWorkRun(
  db: Database,
  params: WorkflowRunParams,
  ports: AiWorkPorts = {},
) {
  const owner = await claimWorkflowRun(db, params);
  if (!owner) return null;
  const input = mailReclassifyRunInput.parse(owner.input);
  const saved = mailReclassificationCheckpoint.safeParse(owner.progress);
  const results = saved.success ? [...saved.data.results] : [];
  const target = input.emails[results.length];
  if (target)
    results.push(
      await executeReclassificationTarget(
        db,
        owner,
        target,
        ports.reclassification,
      ),
    );
  const complete = results.length === input.emails.length;
  const failed = results.some((result) => result.outcome === "failed");
  await writeRunningAttemptProgress(db, owner.id, params.attempt, {
    progress: mailReclassificationCheckpoint.parse({
      kind: "mail_reclassification",
      version: 1,
      attempt: params.attempt,
      complete,
      results,
    }),
    ...(complete
      ? {
          status: failed ? "failed" : "completed",
          endedAt: new Date(),
          failureCode: failed ? "ai_work_failed" : null,
          dispatchError: null,
        }
      : {}),
  });
  return input.emails.length - results.length;
}

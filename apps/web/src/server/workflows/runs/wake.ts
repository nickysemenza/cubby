import type { RunId } from "@cubby/schemas/identifiers";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { getAiRefreshWorkflow, getStepRunWorkflow } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { runAfterCommit } from "~/server/db/helpers/core";
import { aiEvaluationRequest, run } from "~/server/db/schema";

import { WORKFLOW_CONTROL_EVENT } from "./activation";
import { workflowInstanceId } from "./contract";

/** Durable state owns the result; a lost event is recovered at the due-time wait. */
export async function wakeAiEvaluationRequesters(
  db: Database,
  evaluationId: string,
) {
  const binding = getAiRefreshWorkflow();
  if (!binding) return;
  const owners = await getDb(db)
    .select({ shortcode: run.shortcode, progress: run.progress })
    .from(aiEvaluationRequest)
    .innerJoin(run, eq(run.id, aiEvaluationRequest.runId))
    .where(
      and(
        eq(aiEvaluationRequest.evaluationId, evaluationId),
        isNull(aiEvaluationRequest.cancelledAt),
        eq(run.status, "running"),
      ),
    );
  await runAfterCommit(db, () =>
    Promise.allSettled(
      owners.map(async (owner) => {
        const progress = owner.progress;
        const attempt =
          progress &&
          "attempt" in progress &&
          typeof progress.attempt === "number"
            ? progress.attempt
            : 0;
        if (attempt > 0) {
          const instance = await binding.get(
            workflowInstanceId(owner.shortcode, attempt),
          );
          await instance.sendEvent({
            type: WORKFLOW_CONTROL_EVENT,
            payload: {},
          });
          // Legacy pinned instances still wait on their original event type.
          await instance.sendEvent({ type: "ai-work", payload: {} });
        }
      }),
    ).then(() => undefined),
  );
}

/**
 * Wakes the step-ledger Run whose step waits on this child. Best effort: the
 * parent's bounded wait rechecks the child either way.
 */
export async function wakeStepRunParent(db: Database, childRunId: RunId) {
  const binding = getStepRunWorkflow();
  if (!binding) return;
  const { stepParentOf } = await import("~/server/domains/run/repo/run-step");
  const parent = await stepParentOf(db, childRunId);
  if (!parent || parent.status !== "running") return;
  const attempt = z
    .object({ attempt: z.number().default(0) })
    .catch({ attempt: 0 })
    .parse(parent.progress ?? {}).attempt;
  if (!attempt) return;
  const instanceId = workflowInstanceId(parent.shortcode, attempt);
  await runAfterCommit(db, async () => {
    try {
      const instance = await binding.get(instanceId);
      await instance.sendEvent({ type: WORKFLOW_CONTROL_EVENT, payload: {} });
      await instance.sendEvent({ type: "step-run", payload: {} });
    } catch {
      // SILENT: a lost wake is recovered by the parent's bounded wait.
    }
  });
}

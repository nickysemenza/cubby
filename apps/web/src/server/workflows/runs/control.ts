import { MEMBER_CANCELLED_AI_WORK } from "@cubby/schemas/ai-evaluation";
import { systemActor } from "@cubby/schemas/context";
import type { ActorContext } from "@cubby/schemas/context";
import { runShortcode, type RunId } from "@cubby/schemas/identifiers";
import {
  type RunControlAction,
  type ExecutedRunPurpose,
} from "@cubby/schemas/run-fields";
import { runStepState } from "@cubby/schemas/run-step";
import { and, eq, inArray, sql } from "drizzle-orm";

import { grantPaid } from "~/server/ai/funding-wait";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { ledgerParty, runStep, run as runTable } from "~/server/db/schema";
import { reopenRunStep } from "~/server/domains/run/repo/run-step";
import { runControlRefusal } from "~/server/domains/run/run-control-rules";
import { createAppError } from "~/server/errors/app-error";

import { launchWorkflowRun, recordRunProgress } from "./lifecycle";
import { cancelRunPass } from "./run-pass";

/**
 * `run.control` stops or retries the Run's Pass and its child demand.
 * Domain progress and receipts survive an explicit retry.
 * Only the member whose mailbox or search it is may control it.
 */
export async function controlWorkflowRun(
  db: Database,
  actor: ActorContext,
  input: {
    runPublicId: string;
    action: RunControlAction;
    paidOverBudgetUsd?: number;
  },
  purpose: ExecutedRunPurpose,
): Promise<void> {
  const database = getDb(db);
  const [row] = await database
    .select({
      id: runTable.id,
      shortcode: runTable.shortcode,
      status: runTable.status,
      failureCode: runTable.failureCode,
      actorUserId: runTable.actorUserId,
      memberUserId: ledgerParty.userId,
      attempt: sql<number>`coalesce((${runTable.progress}->>'attempt')::int, 0)`,
    })
    .from(runTable)
    .leftJoin(ledgerParty, eq(ledgerParty.id, runTable.ledgerPartyId))
    .where(eq(runTable.shortcode, runShortcode.parse(input.runPublicId)))
    .limit(1);
  if (!row) throw createAppError("RUN_NOT_FOUND", "Run was not found");
  if (
    // Unattended work (AI refresh, nightly maintenance, routine Sweeps and
    // their children) belongs to the household, so any member may control it.
    row.actorUserId !== systemActor().userId &&
    row.actorUserId !== actor.userId &&
    row.memberUserId !== actor.userId
  )
    throw new Error("Only the member this Run belongs to can control it");
  if (
    input.action === "pause" ||
    input.action === "resume" ||
    input.action === "retry"
  ) {
    const refusal = runControlRefusal(input.action, {
      purpose,
      status: row.status,
      failureCode: row.failureCode,
      hasSuccessor: false,
    });
    if (refusal) throw createAppError("RUN_CONTROL_REFUSED", refusal);
  }
  if (input.action === "pause") {
    await withTransactionDatabase(db, async (tx) => {
      await getDb(tx)
        .update(runTable)
        .set({ status: "paused" })
        .where(eq(runTable.id, row.id));
      await cancelRunPass(tx, row.id);
    });
    return;
  }
  if (purpose === "ai_refresh")
    throw new Error("This Run has no current fields scope to resume");
  if (input.action === "run_now_paid") {
    // Every background frontier Workflow shares funding admission. Discovery
    // grants also cover its child imports; unrelated auth pauses stay blocked.
    if (row.status !== "paused_auth" || row.failureCode !== "execution_limit")
      throw createAppError(
        "RUN_CONTROL_REFUSED",
        `Only a funding-paused Run can run now with paid models (${purpose}, ${row.status}, ${row.failureCode})`,
      );
    await grantPaid(db, actor, row.id, input.paidOverBudgetUsd);
    await launchWorkflowRun(db, { runId: row.id, purpose });
    return;
  }
  if (input.action === "resume") {
    await launchWorkflowRun(db, { runId: row.id, purpose });
    return;
  }
  if (input.action === "retry") {
    const stoppedSteps =
      row.failureCode === "user_cancelled"
        ? await database
            .select({ key: runStep.key })
            .from(runStep)
            .where(
              and(
                eq(runStep.runId, row.id),
                eq(runStep.state, runStepState.enum.failed),
                eq(runStep.pausedReason, MEMBER_CANCELLED_AI_WORK),
              ),
            )
        : [];
    await (await import("~/server/kernel/api")).retryRunAsks(db, row.id);
    if (row.failureCode === "user_cancelled") {
      // Re-admitted items still need their interrupted evaluate step to wait for them.
      for (const step of stoppedSteps)
        await reopenRunStep(db, row.id, step.key);
    }
    await launchWorkflowRun(db, { runId: row.id, purpose });
    return;
  }
  if (input.action !== "cancel")
    throw createAppError(
      "RUN_CONTROL_UNSUPPORTED",
      `A ${purpose} Run supports cancel and retry only`,
    );
  if (!["running", "paused", "paused_auth"].includes(row.status))
    throw createAppError(
      "RUN_CONTROL_REFUSED",
      `Only active work can be cancelled (${row.status})`,
    );
  await withTransactionDatabase(db, async (tx) => {
    const database = getDb(tx);
    const kernel = await import("~/server/kernel/api");
    const write = {
      table: runTable,
      entity: "run",
      ids: [row.id],
      columns: ["status", "endedAt", "failureCode"],
    };
    // Revisions before the Run row, the order a kernel apply takes.
    await kernel.lockWrites(tx, write);
    const [cancelled] = await database
      .update(runTable)
      .set({
        status: "failed",
        endedAt: new Date(),
        failureCode: "user_cancelled",
        dispatchError: MEMBER_CANCELLED_AI_WORK,
        progress: sql`coalesce(${runTable.progress}, '{}'::jsonb) || '{"phase":"failed"}'::jsonb`,
      })
      .where(
        and(
          eq(runTable.id, row.id),
          inArray(runTable.status, ["running", "paused", "paused_auth"]),
        ),
      )
      .returning({ id: runTable.id });
    if (!cancelled)
      throw createAppError(
        "RUN_CONTROL_REFUSED",
        "The Run finished before it was cancelled",
      );
    await kernel.emitWrites(tx, write);
    await cancelRunPass(tx, row.id);
    // Cancellation ends execution, without inventing item failures or losing its retry cursor.
    await database
      .update(runStep)
      .set({
        state: runStepState.enum.failed,
        endedAt: new Date(),
        pausedReason: MEMBER_CANCELLED_AI_WORK,
        pausedUntil: null,
      })
      .where(
        and(
          eq(runStep.runId, row.id),
          eq(runStep.state, runStepState.enum.running),
        ),
      );
    await kernel.cancelRunAsks(tx, row.id);
  });
  await recordRunProgress(db, row.id, "cancelled", MEMBER_CANCELLED_AI_WORK, {
    attempt: row.attempt,
    sequence: Number.MAX_SAFE_INTEGER,
  });
}

/** Withdraw this Run's demand without discarding shared paid Answers. */
export async function cancelRunAiWork(
  db: Database,
  runId: RunId,
  _reason: string,
) {
  return (await import("~/server/kernel/api")).cancelRunAsks(db, runId);
}

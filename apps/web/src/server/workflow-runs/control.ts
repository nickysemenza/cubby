import type { ActorContext } from "@cubby/schemas/context";
import { runShortcode } from "@cubby/schemas/identifiers";
import type { RunControlAction } from "@cubby/schemas/run-fields";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { ledgerParty, run as runTable } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { systemActor } from "~/server/runs/ensure-run";

import { workflowInstanceId, type WorkflowRunPurpose } from "./contract";
import { productionWorkflowLauncher, type WorkflowLauncher } from "./launcher";
import {
  launchWorkflowRun,
  recordRunProgress,
  type RunProgressPatch,
} from "./lifecycle";

/** Progress a retry resets per purpose, so the Run reads as live again. */
const RETRY_PROGRESS = {
  ai_refresh: {},
  mail_discovery: {},
} satisfies Record<WorkflowRunPurpose, RunProgressPatch>;

/**
 * `run.control` for a Workflow-backed Run. `cancel` fails the Run first —
 * every step re-checks it before acting — and then terminates the instance;
 * `retry` starts a new attempt that resumes from the Run's saved progress.
 * Only the member whose mailbox or search it is may control it.
 */
export async function controlWorkflowRun(
  db: Database,
  actor: ActorContext,
  input: { runPublicId: string; action: RunControlAction },
  purpose: WorkflowRunPurpose,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
): Promise<void> {
  const database = getDb(db);
  const [row] = await database
    .select({
      id: runTable.id,
      shortcode: runTable.shortcode,
      status: runTable.status,
      actorUserId: runTable.actorUserId,
      memberUserId: ledgerParty.userId,
      attempt: sql<number>`coalesce((${runTable.progress}->>'attempt')::int, 0)`,
    })
    .from(runTable)
    .leftJoin(ledgerParty, eq(ledgerParty.id, runTable.ledgerPartyId))
    .where(eq(runTable.shortcode, runShortcode.parse(input.runPublicId)))
    .limit(1);
  if (!row) throw new Error("Run was not found");
  if (
    !(purpose === "ai_refresh" && row.actorUserId === systemActor().userId) &&
    row.actorUserId !== actor.userId &&
    row.memberUserId !== actor.userId
  )
    throw new Error("Only the member this Run belongs to can control it");
  if (input.action === "retry") {
    if (row.status !== "failed")
      throw new Error(`Only a failed Run can be retried (${row.status})`);
    if (purpose === "ai_refresh") {
      const { aiEvaluation } = await import("~/server/db/schema");
      const failed = await database
        .select()
        .from(aiEvaluation)
        .where(
          and(
            eq(aiEvaluation.runId, row.id),
            inArray(aiEvaluation.state, ["failed", "cancelled"]),
            sql`${aiEvaluation.receipt}->>'retryEvaluationId' IS NULL`,
          ),
        );
      for (const item of failed) {
        const retryId = crypto.randomUUID();
        const [replacement] = await database
          .insert(aiEvaluation)
          .values({
            id: retryId,
            runId: item.runId,
            workKey: `${item.workKey}:operator-retry:${row.attempt + 1}`,
            feature: item.feature,
            target: item.target,
            provenance: item.provenance,
            snapshot: item.snapshot,
            result: item.result,
            state: item.result ? "result_ready" : "queued",
          })
          .onConflictDoNothing()
          .returning({ id: aiEvaluation.id });
        if (replacement)
          await database
            .update(aiEvaluation)
            .set({ receipt: { retryEvaluationId: replacement.id } })
            .where(eq(aiEvaluation.id, item.id));
      }
    }
    await launchWorkflowRun(
      db,
      { runId: row.id, purpose, progressPatch: RETRY_PROGRESS[purpose] },
      launcher,
    );
    return;
  }
  if (input.action !== "cancel")
    throw new Error(`A ${purpose} Run supports cancel and retry only`);
  if (row.status !== "running")
    throw new Error(`Only a running Run can be cancelled (${row.status})`);
  const [cancelled] = await database
    .update(runTable)
    .set({
      status: "failed",
      endedAt: new Date(),
      failureCode: "user_cancelled",
      dispatchError: "Cancelled by a member",
      progress: sql`coalesce(${runTable.progress}, '{}'::jsonb) || '{"phase":"failed"}'::jsonb`,
    })
    .where(
      and(
        eq(runTable.id, row.id),
        eq(runTable.status, "running"),
        // A retry that started after the read owns the Run now.
        sql`coalesce((${runTable.progress}->>'attempt')::int, 0) = ${row.attempt}`,
      ),
    )
    .returning({ id: runTable.id });
  if (!cancelled) throw new Error("The Run finished before it was cancelled");
  if (purpose === "ai_refresh") {
    const { aiEvaluation } = await import("~/server/db/schema");
    await database
      .update(aiEvaluation)
      .set({
        state: "cancelled",
        deadlineAt: null,
        error: "Cancelled by a member",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiEvaluation.runId, row.id),
          inArray(aiEvaluation.state, [
            "queued",
            "running",
            "result_ready",
            "retry_wait",
          ]),
        ),
      );
  }
  await recordRunProgress(db, row.id, "cancelled", "Cancelled by a member", {
    attempt: row.attempt,
    sequence: Number.MAX_SAFE_INTEGER,
  });
  if (row.attempt > 0)
    await launcher.terminate(
      purpose,
      workflowInstanceId(row.shortcode, row.attempt),
    );
}

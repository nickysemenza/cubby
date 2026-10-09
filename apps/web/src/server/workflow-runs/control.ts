import type { ActorContext } from "@cubby/schemas/context";
import { runShortcode } from "@cubby/schemas/identifiers";
import type { RunControlAction } from "@cubby/schemas/run-fields";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { ledgerParty, run as runTable } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import { workflowInstanceId, type WorkflowRunPurpose } from "./contract";
import { productionWorkflowLauncher, type WorkflowLauncher } from "./launcher";
import {
  launchWorkflowRun,
  recordRunProgress,
  type RunProgressPatch,
} from "./lifecycle";

/** Progress a retry resets per purpose, so the Run reads as live again. */
const RETRY_PROGRESS = {
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
  if (row.actorUserId !== actor.userId && row.memberUserId !== actor.userId)
    throw new Error("Only the member this Run belongs to can control it");
  if (input.action === "retry") {
    if (row.status !== "failed")
      throw new Error(`Only a failed Run can be retried (${row.status})`);
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
  await recordRunProgress(db, row.id, "cancelled", "Cancelled by a member");
  if (row.attempt > 0)
    await launcher.terminate(
      purpose,
      workflowInstanceId(row.shortcode, row.attempt),
    );
}

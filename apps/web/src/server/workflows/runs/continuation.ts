import type { Database } from "~/server/db";

import { isWorkflowRunPurpose, type WorkflowRunParams } from "./contract";
import { productionWorkflowLauncher, type WorkflowLauncher } from "./launcher";
import { claimWorkflowRun, launchWorkflowRun } from "./lifecycle";

/** The persisted cursor stays on the Run; only its current owner can hand off. */
export async function continueWorkflowRun(
  db: Database,
  params: WorkflowRunParams,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
): Promise<void> {
  const owner = await claimWorkflowRun(db, params);
  if (!owner || !isWorkflowRunPurpose(owner.purpose)) return;
  await launchWorkflowRun(
    db,
    {
      runId: owner.id,
      purpose: owner.purpose,
      expectedAttempt: params.attempt,
      automatic: true,
    },
    launcher,
  );
}

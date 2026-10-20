import type { Database } from "~/server/db";
import { claimDerivedDiscovery } from "~/server/domains/run/repo/derived-discovery";
import {
  productionWorkflowLauncher,
  type WorkflowLauncher,
} from "~/server/workflows/runs/launcher";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

/** Admission and pass ownership commit before the external Workflow starts. */
export async function scheduleDerivedDiscovery(
  db: Database,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
) {
  const runId = await claimDerivedDiscovery(db);
  if (runId)
    await launchWorkflowRun(
      db,
      { runId, purpose: "sweep", automatic: true },
      launcher,
    );
}

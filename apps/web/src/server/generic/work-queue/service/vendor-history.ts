import type { Database } from "~/server/db";
import {
  materializeVendorHistory,
  prepareAuthorizedVendorMail,
} from "~/server/generic/work-queue/repo/vendor-history";
import {
  productionWorkflowLauncher,
  type WorkflowLauncher,
} from "~/server/workflows/runs/launcher";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

export async function advanceVendorHistory(
  db: Database,
  hints: Parameters<typeof materializeVendorHistory>[1] = {},
  launcher: WorkflowLauncher = productionWorkflowLauncher,
) {
  for (const intent of await materializeVendorHistory(db, hints))
    await startAuthorizedVendorMail(db, intent, launcher);
}

/** Dispatch only after the writer has committed the immutable query snapshot. */
export async function startAuthorizedVendorMail(
  db: Database,
  input: Parameters<typeof prepareAuthorizedVendorMail>[1],
  launcher: WorkflowLauncher = productionWorkflowLauncher,
) {
  const prepared = await prepareAuthorizedVendorMail(db, input);
  if (prepared.status === "started")
    await launchWorkflowRun(
      db,
      { runId: prepared.runId, purpose: "mail_discovery", automatic: true },
      launcher,
    );
  return prepared;
}

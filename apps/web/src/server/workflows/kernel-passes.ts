/**
 * The workflow module's passes: Run execution, stopped-execution
 * reconciliation, retention, purchase admission and calendar invalidation.
 */
import { defineModule, type Pass } from "~/server/kernel/api";

import { calendarInvalidatePass } from "./calendar-invalidate-pass";
import { purchaseDiscoveryPass } from "./purchase-discovery-pass";
import { retentionPass } from "./retention-pass";
import { runsReconcilePass } from "./runs/reconcile-pass";
import { runExecutePass } from "./runs/run-pass";

const WORKFLOW_PASSES: readonly Pass[] = [
  retentionPass,
  purchaseDiscoveryPass,
  calendarInvalidatePass,
  runExecutePass,
  runsReconcilePass,
];

export const workflowKernelModule = defineModule({
  name: "workflows",
  passes: WORKFLOW_PASSES,
});

/**
 * The platform passes the kernel runs (ADR 0029 section 7): Run execution,
 * Run status reconciliation, retention, the derived snapshot, purchase
 * discovery and the calendar invalidation fallback. The Run domain module
 * registers them until the kernel's module list names a module of its own.
 */
import type { Pass } from "~/server/kernel/api";

import { calendarInvalidatePass } from "./calendar-invalidate-pass";
import { runsReconcilePass } from "./runs/reconcile-pass";
import { runExecutePass } from "./runs/run-pass";

export const WORKFLOW_PASSES: readonly Pass[] = [
  calendarInvalidatePass,
  runExecutePass,
  runsReconcilePass,
];

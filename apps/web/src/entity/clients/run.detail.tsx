import type { RunOut } from "@cubby/schemas/run";
import {
  hasImportRunReports,
  type RunPurpose,
} from "@cubby/schemas/activity-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";

import {
  RunAgentActions,
  RunImportAgentActive,
  RunImportAgentStopped,
  RunImportControls,
  RunPhotoBatch,
} from "~/app/purchases/purchase-import-run-detail";
import { RunChanges, runReportSlots } from "~/app/runs/slots";
import {
  defineDetailHooks,
  type DetailSlot,
  type DetailSlotComponent,
} from "~/entity/entity-detail/detail-hooks";
import {
  ReportDetailActions,
  RunSentryAction,
} from "~/entity/entity-detail/report-slot";

const isImportRun = (run: { purpose: RunPurpose }) =>
  hasImportRunReports(run.purpose);

const isLiveRun = (run: { status: string }) =>
  ACTIVE_RUN_STATUSES.some((status) => status === run.status);

/** A Run slot that is nothing but its server-composed report (`run.<slot>` in `reportSlots`). */
const runReportSlot = (
  report: keyof typeof runReportSlots,
  applies?: (run: RunOut) => boolean,
): DetailSlot<"run"> =>
  applies
    ? { component: runReportSlots[report], applies }
    : { component: runReportSlots[report] };

const RunDetailActions: DetailSlotComponent<"run"> = ({ record }) => (
  <>
    <ReportDetailActions
      slot="run.live-progress"
      id={record.id}
      status={record.status}
    />
    <RunAgentActions record={record} />
    <RunSentryAction error={record.dispatchError} />
  </>
);

export const runDetailHooks = defineDetailHooks("run", {
  slots: {
    // Progress, usage and changes are server-composed report slots; `runReportSlot` is their one
    // component (`app/runs/slots.tsx`).
    "live-progress": runReportSlot("live-progress"),
    "import-controls": { component: RunImportControls, applies: isImportRun },
    "import-stats": runReportSlot("import-stats", isImportRun),
    "import-progress-live": runReportSlot(
      "import-progress-live",
      (run) => isImportRun(run) && isLiveRun(run),
    ),
    "import-agent-live": {
      component: RunImportAgentActive,
      applies: isImportRun,
    },
    "import-purchases": runReportSlot("import-purchases", isImportRun),
    "import-approvals": runReportSlot("import-approvals", isImportRun),
    "import-findings": runReportSlot("import-findings", isImportRun),
    "import-targets": runReportSlot("import-targets", isImportRun),
    "import-evidence": runReportSlot("import-evidence", isImportRun),
    "import-prepared-orders": runReportSlot(
      "import-prepared-orders",
      isImportRun,
    ),
    "import-progress-stopped": runReportSlot(
      "import-progress-stopped",
      (run) => isImportRun(run) && !isLiveRun(run),
    ),
    "import-agent-stopped": {
      component: RunImportAgentStopped,
      applies: isImportRun,
    },
    "import-timeline": runReportSlot("import-timeline", isImportRun),
    "import-debug-log": runReportSlot("import-debug-log", isImportRun),
    "photo-batch": {
      component: RunPhotoBatch,
      applies: (run) => run.purpose === "photo_inventory",
    },
    "ai-usage": runReportSlot("ai-usage"),
    changes: { component: RunChanges },
  },
  headerActions: RunDetailActions,
});

import type { ReportSlot } from "@cubby/schemas/entity-report";
import type { RunOut } from "@cubby/schemas/run";

import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { AuditLogList } from "~/features/audit-log/audit-log-list";

/**
 * A Run detail slot that is nothing but its server-composed report (`run.<id>` in
 * `reportSlots`): progress, approvals, findings, transcript, log, AI usage. (Targets keep their
 * web fill for the corrections review; changes keep the audit list's field diffs.) The record's status
 * rides along so the page refreshes the Run when the report read a newer one.
 */
const runReport =
  (slot: Extract<ReportSlot, `run.${string}`>): DetailSlotComponent<"run"> =>
  ({ record }: { record: RunOut }) => (
    <EntityReportSlot slot={slot} id={record.id} status={record.status} />
  );

export const runReportSlots = {
  "live-progress": runReport("run.live-progress"),
  "import-stats": runReport("run.import-stats"),
  "import-progress-live": runReport("run.import-progress-live"),
  "import-progress-stopped": runReport("run.import-progress-stopped"),
  "import-purchases": runReport("run.import-purchases"),
  "import-approvals": runReport("run.import-approvals"),
  "import-findings": runReport("run.import-findings"),
  "import-evidence": runReport("run.import-evidence"),
  "import-timeline": runReport("run.import-timeline"),
  "import-debug-log": runReport("run.import-debug-log"),
  "ai-usage": runReport("run.ai-usage"),
} as const;

/** Run detail slot: every audit entry the run wrote, with the full field diffs. */
export function RunChanges({ record }: { record: RunOut }) {
  return <AuditLogList runId={record.id} />;
}

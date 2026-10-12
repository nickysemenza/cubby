import type { ReportSlot } from "@cubby/schemas/entity-report";
import type { RunOut } from "@cubby/schemas/run";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { AuditLogList } from "~/features/audit-log/audit-log-list";
import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCount } from "~/lib/utils";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Stack } from "~/ui/layout";
import { Description } from "~/ui/primitives/description";

/**
 * A Run detail slot that is nothing but its server-composed report (`run.<id>` in
 * `reportSlots`): progress, targets, approvals, findings, transcript, log, AI usage. Changes keep the audit list's field diffs. The record's status
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
  "import-targets": runReport("run.import-targets"),
  "import-prepared-orders": runReport("run.import-prepared-orders"),
  "import-timeline": runReport("run.import-timeline"),
  "import-debug-log": runReport("run.import-debug-log"),
  "ai-usage": runReport("run.ai-usage"),
} as const;

/** A sweep Run's stored outcomes and the way into reviewing what is pending. */
export function RunSuggestions({ record }: { record: RunOut }) {
  const counts = useQuery(
    ai.suggestionCounts.queryOptions({ runId: record.id }),
  );
  if (counts.error)
    return <ErrorDisplay error={counts.error} title="suggestion counts" />;
  if (!counts.data)
    return <Description size="xs">Loading suggestions…</Description>;
  const total = (key: "pending" | "applied" | "rejected" | "superseded") =>
    counts.data.reduce((sum, row) => sum + row[key], 0);
  const pending = total("pending");
  return (
    <Stack gap="sm">
      <p className="text-sm tabular-nums">
        {formatCount(pending)} pending · {formatCount(total("applied"))}{" "}
        accepted · {formatCount(total("rejected"))} rejected ·{" "}
        {formatCount(total("superseded"))} superseded
      </p>
      {pending > 0 ? (
        <Link
          to="/ai"
          search={{ tab: "review", runId: record.id }}
          className="text-sm font-medium text-primary underline-offset-2 hover:underline"
        >
          Review {formatCount(pending)} pending
        </Link>
      ) : null}
    </Stack>
  );
}

/** Run detail slot: every audit entry the run wrote, with the full field diffs. */
export function RunChanges({ record }: { record: RunOut }) {
  return <AuditLogList runId={record.id} />;
}

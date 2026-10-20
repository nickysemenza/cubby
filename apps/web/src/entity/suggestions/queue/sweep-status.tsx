import type { ReportBlock } from "@cubby/schemas/entity-report";
import { runShortcode } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { compileEntityListInput, entityListFor } from "~/entity/entity-list";
import { entityReport } from "~/integrations/tanstack-query/generated/catalog.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";

const POLL_MS = 3000;
const RUNNING_SWEEPS = compileEntityListInput(
  "run",
  { purpose: "sweep", status: "running" },
  { pageSize: 1 },
);

type StepRow = Extract<ReportBlock, { kind: "records" }>["rows"][number];

/** The newest Sweep still running, when none was started from this page. */
export function useRunningSweep(enabled: boolean): string | null {
  const list = entityListFor("run");
  const running = useQuery({
    ...list.queryOptions(RUNNING_SWEEPS),
    enabled,
    refetchInterval: POLL_MS * 4,
  });
  return runShortcode.safeParse(running.data?.items[0]?.id).data ?? null;
}

/**
 * One line for a Sweep: its Run link, "step N of M", and the current step's
 * own count line, polled from the Run's Steps report while it moves.
 * `onSettled` fires once when a watched Sweep stops being live.
 */
export function SweepStatusLine({
  runId,
  onSettled,
}: {
  runId: string;
  onSettled?: () => void;
}) {
  const report = useQuery({
    ...entityReport.get.queryOptions({
      slot: "run.steps",
      scope: { kind: "record", id: runId },
    }),
    refetchInterval: (query) =>
      query.state.data?.live === false ? false : POLL_MS,
  });
  const live = report.data?.live;
  const settled = useRef(false);
  useEffect(() => {
    if (live === false && !settled.current) {
      settled.current = true;
      onSettled?.();
    }
  }, [live, onSettled]);
  const steps: StepRow[] =
    report.data?.blocks.flatMap((block) =>
      block.kind === "records"
        ? block.rows.filter((row) => row.state?.kind !== "skipped")
        : [],
    ) ?? [];
  const currentIndex = steps.findIndex(
    (step) =>
      step.state?.kind === "running" || step.state?.kind === "not_reached",
  );
  const current = currentIndex >= 0 ? steps[currentIndex] : undefined;
  const failed = steps.filter((step) => step.state?.kind === "failed").length;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-card px-2.5 py-1.5 text-xs"
      aria-live="polite"
      aria-label="Sweep status"
    >
      <span className="font-medium">Sweep</span>
      <EntityRefLink variant="byId" entityKind="run" entityId={runId} compact />
      {report.error ? (
        <ErrorDisplay error={report.error} title="Sweep steps" />
      ) : !report.data ? (
        <span className="text-muted-foreground">Loading steps…</span>
      ) : live ? (
        <>
          <span>running</span>
          {steps.length ? (
            <span className="text-muted-foreground tabular-nums">
              · step {Math.max(currentIndex, 0) + 1} of {steps.length}
            </span>
          ) : null}
          {current ? (
            <span className="min-w-0 truncate text-muted-foreground">
              · {current.title}
              {current.lines?.[0] ? ` ${current.lines[0].text}` : ""}
            </span>
          ) : null}
        </>
      ) : (
        <span className="text-muted-foreground">
          {report.data.status ? `${report.data.status}` : "finished"}
          {failed ? ` · ${failed} failed` : ""}
        </span>
      )}
    </div>
  );
}

import { entitySchema } from "@cubby/schemas/entity";
import { entityRoster } from "@cubby/schemas/entity-roster";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { countLabel } from "@cubby/shared/pluralize";
import { humanize } from "@cubby/shared/text-case";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { MinusCircleIcon } from "@phosphor-icons/react/dist/csr/MinusCircle";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { RunEvaluationsOut } from "~/contracts/run-detail.contract";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import {
  formatMinutesLeft,
  formatPace,
} from "~/features/activity/work-streams";
import { runDetail } from "~/integrations/tanstack-query/domains/runDetail";
import { formatRelative } from "~/lib/date-format";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { useSectionCount } from "~/ui/data-table/detail-section-state";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
import { Button } from "~/ui/primitives/button";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "~/ui/primitives/progress";
import { StaticTable } from "~/ui/primitives/static-table";

const LIVE_POLL_MS = 5_000;

const live = (status: string) =>
  ACTIVE_RUN_STATUSES.some((active) => active === status);

const kindLabel = (entity: string | null) => {
  const parsed = entitySchema.safeParse(entity);
  return parsed.success ? entityRoster[parsed.data].singular : "Other";
};

type Outcome = RunEvaluationsOut["recent"][number];

function outcomeText(outcome: Outcome) {
  if (outcome.state === "failed")
    return outcome.error ?? "Failed without a recorded error";
  if (outcome.state === "obsolete")
    return `Skipped: ${outcome.reason ?? "the record changed"}`;
  if (outcome.state === "blocked") return outcome.reason ?? "Blocked";
  if (outcome.candidates === null) return "Checked";
  return outcome.candidates
    ? countLabel(outcome.candidates, "suggestion")
    : "No suggestions";
}

function OutcomeGlyph({ outcome }: { outcome: Outcome }) {
  const className = "size-3.5 shrink-0";
  if (outcome.state === "failed")
    return (
      <WarningCircleIcon
        aria-label="Failed"
        className={cn(className, "text-destructive")}
      />
    );
  if (outcome.state === "completed")
    return (
      <CheckCircleIcon
        aria-label="Done"
        className={cn(
          className,
          outcome.candidates ? "text-positive" : "text-muted-foreground",
        )}
      />
    );
  return (
    <MinusCircleIcon
      aria-label="Skipped"
      className={cn(className, "text-muted-foreground")}
    />
  );
}

/**
 * Progress for a Run that owns AI evaluations: how far it got, how fast it
 * moves now, where the time goes by record kind, and what each recent record
 * turned into. A discovery pass also shows its walk through every record.
 */
export function RunEvaluations({ record }: { record: EvaluationRun }) {
  const [failedOnly, setFailedOnly] = useState(false);
  // Active statuses include pauses for polling; only running work has a live pace.
  const polling = live(record.status) ? LIVE_POLL_MS : false;
  const result = useQuery({
    ...runDetail.evaluations.queryOptions({ runId: record.id, failedOnly }),
    refetchInterval: polling,
  });
  const data = result.data;
  const now = useDisplayNow() ?? Date.now();
  const stale = Boolean(
    data && now - Date.parse(data.measuredAt) > 3 * LIVE_POLL_MS,
  );
  const moving = record.status === "running" && !stale;
  const totals = (data?.byKind ?? []).reduce(
    (sum, kind) => ({
      settled: sum.settled + kind.completed + kind.failed + kind.obsolete,
      waiting: sum.waiting + kind.waiting,
      failed: sum.failed + kind.failed,
      cancelled: sum.cancelled + kind.cancelled,
    }),
    { settled: 0, waiting: 0, failed: 0, cancelled: 0 },
  );
  const total = totals.settled + totals.waiting + totals.cancelled;
  useSectionCount(data ? total : undefined);
  const pace = moving ? (data?.pace.completedPerMinute ?? 0) : 0;
  const minutesLeft =
    pace > 0 && totals.waiting > 0 ? totals.waiting / pace : null;

  if (result.isPending)
    return <RecordList state={{ status: "pending", rows: 3 }} />;
  if (result.isError || !data)
    return (
      <RecordList
        state={{
          status: "error",
          error: result.error,
          title: "Couldn't load evaluation progress",
          onRetry: () => void result.refetch(),
        }}
      />
    );

  const facts = [
    stale ? `Data measured ${formatRelative(data.measuredAt, now)}` : null,
    pace > 0
      ? `${formatPace(pace)} over ${data.pace.windowMinutes} min`
      : moving
        ? "Not moving right now"
        : null,
    minutesLeft !== null
      ? `${formatMinutesLeft(minutesLeft)} left for what is queued`
      : null,
    data.pace.lastCompletedAt
      ? `last finished ${formatRelative(data.pace.lastCompletedAt, now)}`
      : null,
    totals.failed ? `${formatCount(totals.failed)} failed` : null,
    totals.cancelled ? `${formatCount(totals.cancelled)} cancelled` : null,
  ].filter(Boolean);

  return (
    <div className="grid gap-4" data-testid="run-evaluations">
      <div className="grid gap-1.5">
        {data.roster ? (
          <Progress
            value={data.roster.walked}
            max={data.roster.total}
            paused={!moving || pace === 0}
          >
            <ProgressLabel>Records checked</ProgressLabel>
            <ProgressValue>
              {() =>
                `${formatCount(data.roster?.walked ?? 0)} of ${formatCount(data.roster?.total ?? 0)}`
              }
            </ProgressValue>
          </Progress>
        ) : null}
        <Progress
          value={totals.settled}
          max={total}
          paused={!moving || pace === 0}
        >
          <ProgressLabel>Evaluations settled</ProgressLabel>
          <ProgressValue>
            {() => `${formatCount(totals.settled)} of ${formatCount(total)}`}
          </ProgressValue>
        </Progress>
        {facts.length ? (
          <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>
        ) : null}
      </div>

      {data.byKind.length ? (
        <StaticTable
          aria-label="Evaluations by record kind"
          rows={data.byKind}
          rowKey={(row) => `${row.entity ?? ""}:${row.feature}`}
          columns={[
            {
              id: "kind",
              header: "Record",
              rowHeader: true,
              cell: (row) =>
                data.byKind.some((other) => other.feature !== row.feature)
                  ? `${kindLabel(row.entity)} · ${humanize(row.feature.replace(/[._:-]+/g, " "))}`
                  : kindLabel(row.entity),
            },
            ...(
              [
                ["completed", "Done"],
                ["waiting", "Waiting"],
                ["failed", "Failed"],
                ["obsolete", "Skipped"],
                ["cancelled", "Cancelled"],
              ] as const
            ).map(([key, header]) => ({
              id: key,
              header,
              headClassName: "text-right",
              cellClassName: "text-right font-mono tabular-nums",
              cell: (row: RunEvaluationsOut["byKind"][number]) =>
                row[key] ? formatCount(row[key]) : "·",
            })),
          ]}
        />
      ) : null}

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Latest outcomes</h3>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={failedOnly}
            onClick={() => setFailedOnly(!failedOnly)}
          >
            {failedOnly ? "Show all outcomes" : "Failures only"}
          </Button>
        </div>
        <RecordList
          state={{ status: "success" }}
          empty={
            <span>
              {failedOnly ? "No failures." : "Nothing has finished yet."}
            </span>
          }
        >
          {data.recent.map((outcome) => {
            const entity = entitySchema.safeParse(outcome.entity);
            return (
              <RecordRow
                key={outcome.id}
                leading={<OutcomeGlyph outcome={outcome} />}
                primary={
                  entity.success && outcome.recordCode ? (
                    <EntityRefLink
                      entity={entity.data}
                      id={outcome.recordCode}
                      bare
                    />
                  ) : (
                    kindLabel(outcome.entity)
                  )
                }
                secondary={
                  <span
                    className={cn(
                      outcome.state === "failed" && "text-destructive",
                    )}
                  >
                    {outcomeText(outcome)}
                  </span>
                }
                trailing={formatRelative(outcome.settledAt, now)}
              />
            );
          })}
        </RecordList>
      </div>
    </div>
  );
}

type EvaluationRun = Pick<DetailRecordOf<"run">, "id" | "status">;

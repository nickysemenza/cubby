import type { RunShortcode } from "@cubby/schemas/identifiers";
import {
  describeJobRollup,
  describeJobWaitingOn,
  JOB_LANE_LABEL,
  JOB_WAITING_ON_LABEL,
  type JobLane,
  type JobState,
  type JobWaitingOnReason,
} from "@cubby/schemas/job";
import { jobFilters, jobOut } from "@cubby/schemas/job-entity";
import { countLabel } from "@cubby/shared/pluralize";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { toast } from "sonner";

import type { JobSetFilter } from "~/contracts/job.contract";
import { EmbeddedEntityList } from "~/entity/entity-list/generic-entity-list";
import type {
  BaseListRow,
  UseEntityListReturn,
} from "~/entity/hooks/use-entity-list";
import { WorkFeed } from "~/features/activity/work-feed";
import { JobLogPanel } from "~/features/job/job-diagnostics";
import { derived } from "~/integrations/tanstack-query/generated/catalog/derived.gen";
import { job } from "~/integrations/tanstack-query/generated/catalog/job.gen";
import { formatCount } from "~/lib/number-format";
import { roundTo } from "~/lib/round-to";
import { DerivedBacklogOverview } from "~/ui/derived/backlog";
import { showErrorToast } from "~/ui/feedback/error-details";
import { Panel, Row, Section, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { StatusText } from "~/ui/primitives/status-text";

export type QueueSearch = {
  lane?: JobLane | undefined;
  reason?: JobWaitingOnReason | undefined;
  state?: JobState | undefined;
  kind?: string | undefined;
  runId?: RunShortcode | undefined;
  attention?: boolean | undefined;
  page?: number | undefined;
};
const formatEta = (seconds: number) => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.round(hours / 24)} days`;
};

function DeviceBacklogNotice() {
  const backlog = useQuery({
    ...job.deviceBacklog.queryOptions({}),
    refetchInterval: 15_000,
  });
  const data = backlog.data;
  if (!data?.waiting) return null;
  const idle = data.workingDevices === 0;
  return (
    <Panel tone={idle ? "warning" : "muted"} data-testid="device-backlog">
      <output className="grid gap-1 text-sm">
        <p>
          <Link
            to="/image-jobs"
            search={{ state: "waiting_for_device" }}
            className="font-medium text-link hover:underline"
          >
            {countLabel(data.waiting, "image")} waiting for an Apple device
          </Link>
          {data.runsWaiting
            ? ` · holding up ${countLabel(data.runsWaiting, "Run")}`
            : ""}
        </p>
        <p className="text-xs text-muted-foreground">
          {idle
            ? "No Apple device is processing. Keep Cubby open on your Mac (or run `cubby companion`) to work through it."
            : `${countLabel(data.workingDevices, "device")} working · ${formatCount(roundTo(data.claimsPerMinute, 1))} jobs/min${
                data.etaSeconds === null
                  ? ""
                  : ` · about ${formatEta(data.etaSeconds)} at this pace`
              }`}
        </p>
      </output>
    </Panel>
  );
}

function JobExplain({ id, error }: { id: string; error: string | null }) {
  const explain = useQuery(job.explain.queryOptions({ id }));
  if (explain.isPending) return <StatusText>Explaining…</StatusText>;
  if (explain.isError)
    return <StatusText tone="destructive">{explain.error.message}</StatusText>;
  const rollup = explain.data.rollup;
  return (
    <Stack gap="tight">
      <ol className="grid gap-1">
        {explain.data.steps.map((step) => (
          <li key={`${step.kind}:${step.ref}`} className="grid gap-0.5">
            <span>
              <span className="font-medium">{step.label}</span>{" "}
              <span className="text-muted-foreground">· {step.state}</span>
            </span>
            {step.waitingOn ? (
              <span className="text-muted-foreground">
                {describeJobWaitingOn(step.waitingOn)}
              </span>
            ) : null}
            {step.detail && step.detail !== error ? (
              <span className="font-mono break-words text-muted-foreground">
                {step.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      {rollup ? (
        <span className="text-muted-foreground">
          Run {rollup.runId}:{" "}
          {describeJobRollup(rollup.counts, rollup.expiredLeases) ??
            "no live Jobs"}
          {rollup.stalled ? ` · stalled for ${rollup.stallMinutes}+ min` : ""}
        </span>
      ) : null}
      {error ? (
        <pre className="max-h-[30vh] overflow-auto rounded-lg bg-destructive-surface px-2.5 py-2 font-mono text-xs/4.25 break-words whitespace-pre-wrap text-destructive">
          {error}
        </pre>
      ) : null}
    </Stack>
  );
}

function QueueSummary({
  search,
  onSearchChange,
}: {
  search: QueueSearch;
  onSearchChange: (next: Partial<QueueSearch>) => void;
}) {
  const all = useQuery({
    ...job.queue.queryOptions({ filter: { entityFilters: {} }, pageSize: 1 }),
    refetchInterval: 15_000,
  });
  if (all.isPending) return <StatusText>Loading queue counts…</StatusText>;
  if (all.isError)
    return <StatusText tone="destructive">{all.error.message}</StatusText>;
  return (
    <Row gap="sm" wrap aria-label="Queue counts">
      {all.data.counts.map(({ lane, reason, count }) => (
        <Button
          key={`${lane}:${reason}`}
          variant={
            search.lane === lane && search.reason === reason
              ? "secondary"
              : "outline"
          }
          size="sm"
          onClick={() => onSearchChange({ lane, reason, page: undefined })}
        >
          {JOB_LANE_LABEL[lane]} · {JOB_WAITING_ON_LABEL[reason]}{" "}
          {formatCount(count)}
        </Button>
      ))}
      {Object.values(search).some((value) => value !== undefined) ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onSearchChange({
              lane: undefined,
              reason: undefined,
              state: undefined,
              kind: undefined,
              runId: undefined,
              attention: undefined,
              page: undefined,
            })
          }
        >
          Clear Job filters
        </Button>
      ) : null}
    </Row>
  );
}

function RetryJobsButton({
  filter,
  label = "Retry now",
}: {
  filter: JobSetFilter;
  label?: string;
}) {
  const retry = useMutation(
    job.retryNow.mutationOptions({
      onSuccess: ({ retried }) =>
        toast.success(`Retry now: ${countLabel(retried, "Job")} made due`),
      onError: (error) => showErrorToast(error, "Retry now failed"),
    }),
  );
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={retry.isPending}
      onClick={() => retry.mutate({ filter })}
    >
      {retry.isPending ? "Retrying…" : label}
    </Button>
  );
}

function JobActions({ list }: { list: UseEntityListReturn<BaseListRow> }) {
  const selection = list.workbench.table.atoms.rowSelection?.get() ?? {};
  const codes = Object.keys(selection).filter((id) => selection[id]);
  const filter: JobSetFilter = {
    entityFilters: jobFilters.parse(list.currentFilters),
    ...(codes.length
      ? { codes: codes.map((code) => jobOut.shape.id.parse(code)) }
      : {}),
  };
  return (
    <RetryJobsButton
      filter={filter}
      label={
        codes.length
          ? `Retry ${countLabel(codes.length, "selected Job")} now`
          : "Retry matching Jobs now"
      }
    />
  );
}

const RUN_COLUMNS = [
  "name",
  "workProgress",
  "purpose",
  "status",
  "waitingOn",
  "stalled",
  "startedAt",
  "chargedCost",
];
const RUN_SORT = [
  { id: "stalled", desc: true },
  { id: "startedAt", desc: true },
];
const JOB_COLUMNS = [
  "name",
  "kind",
  "lane",
  "state",
  "waitingOn",
  "runId",
  "imageId",
  "locationId",
  "attempts",
  "error",
  "leaseExpiresAt",
  "createdAt",
  "updatedAt",
];
const JOB_DETAIL = {
  label: "Explain",
  render: (row: BaseListRow) => (
    <div className="grid gap-2 px-2 py-2" data-testid="job-explain">
      <JobExplain
        id={row.id}
        error={jobOut.pick({ error: true }).partial().parse(row).error ?? null}
      />
      <RetryJobsButton filter={{ codes: [jobOut.shape.id.parse(row.id)] }} />
      <JobLogPanel jobId={row.id} />
    </div>
  ),
};

/** Values that waited this long are worth a breakdown; a burst that clears sooner is not. */
const DERIVED_BREAKDOWN_AFTER_SECONDS = 60;

/**
 * The per-record-type breakdown of waiting derived values, shown only while
 * some value has waited over a minute. "Now" reports the routine pace, so a
 * backlog that drains between reads no longer flashes a table in and out.
 */
function DerivedBacklogSection() {
  const backlog = useQuery({
    ...derived.backlog.queryOptions({}),
    refetchInterval: 15_000,
  });
  if (
    (backlog.data?.oldestWaitingSeconds ?? 0) < DERIVED_BREAKDOWN_AFTER_SECONDS
  )
    return null;
  return (
    <Section headingAs="h2" title="Derived values" id="derived-values">
      <DerivedBacklogOverview />
    </Section>
  );
}

export function QueueOverview({
  search,
  onSearchChange,
}: {
  search: QueueSearch;
  onSearchChange: (next: Partial<QueueSearch>) => void;
}) {
  const health = useQuery({
    ...job.health.queryOptions({}),
    refetchInterval: 15_000,
  });
  const filters = useMemo(
    () => ({
      ...(search.lane ? { lane: [search.lane] } : {}),
      ...(search.reason ? { reason: [search.reason] } : {}),
      ...(search.state ? { state: [search.state] } : {}),
      ...(search.kind ? { kind: [search.kind] } : {}),
      ...(search.runId ? { runId: [search.runId] } : {}),
      ...(search.attention ? { needsAttention: true } : {}),
    }),
    [
      search.lane,
      search.reason,
      search.state,
      search.kind,
      search.runId,
      search.attention,
    ],
  );
  return (
    <Stack gap="lg">
      <DeviceBacklogNotice />
      <WorkFeed
        health={health.data?.snapshot}
        onShowJobs={(kind) =>
          onSearchChange({
            kind,
            lane: undefined,
            reason: undefined,
            page: undefined,
          })
        }
      />
      <DerivedBacklogSection />
      <Section headingAs="h2" title="Runs needing attention">
        <EmbeddedEntityList
          entity="run"
          savedViewId="attention"
          pageSize={10}
          sort={RUN_SORT}
          columns={RUN_COLUMNS}
          refreshIntervalMs={15_000}
          allLink
        />
      </Section>
      <Section headingAs="h2" title="Jobs" id="queue-jobs">
        <QueueSummary search={search} onSearchChange={onSearchChange} />
        <EmbeddedEntityList
          key={JSON.stringify(filters)}
          entity="job"
          filters={filters}
          savedViewId="in-progress"
          pageSize={25}
          columns={JOB_COLUMNS}
          detail={JOB_DETAIL}
          actions={(list) => <JobActions list={list} />}
          refreshIntervalMs={15_000}
          allLink
        />
      </Section>
    </Stack>
  );
}

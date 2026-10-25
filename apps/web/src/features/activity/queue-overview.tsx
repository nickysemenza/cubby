import type { RunShortcode } from "@cubby/schemas/identifiers";
import {
  describeJobRollup,
  describeJobWaitingOn,
  JOB_LANE_LABEL,
  JOB_WAITING_ON_LABEL,
  jobLane,
  jobState,
  jobWaitingOnReason,
  type JobLane,
  type JobState,
  type JobWaitingOnReason,
} from "@cubby/schemas/job";
import { VISIBLE_RUN_PURPOSES } from "@cubby/schemas/run-fields";
import { countLabel } from "@cubby/shared/pluralize";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import type {
  JobFacts,
  JobSetFilter,
  QueueHealthSnapshot,
} from "~/contracts/job.contract";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entityListFor } from "~/entity/entity-list";
import { runHref } from "~/entity/routing/purchase-import-links";
import { job } from "~/integrations/tanstack-query/generated/catalog/job.gen";
import { formatRelative } from "~/lib/date-format";
import { formatCount } from "~/lib/number-format";
import { Picker } from "~/ui/combobox/picker";
import {
  RecordDetail,
  RecordGroup,
  RecordList,
  RecordRow,
} from "~/ui/common/record-list";
import { showErrorToast } from "~/ui/feedback/error-details";
import { Row, Section, Stack } from "~/ui/layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/ui/primitives/alert-dialog";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { StatusText } from "~/ui/primitives/status-text";

import { JobStatePill } from "../job/job-status";

/** The Job set a URL names: every key narrows; none is every live Job. */
export type QueueSearch = {
  lane?: JobLane | undefined;
  reason?: JobWaitingOnReason | undefined;
  state?: JobState | undefined;
  kind?: string | undefined;
  runId?: RunShortcode | undefined;
  attention?: boolean | undefined;
  page?: number | undefined;
};

const PAGE_SIZE = 25;
const LANES = jobLane.options;

function queueFilterOf(search: QueueSearch): JobSetFilter {
  return {
    ...(search.lane ? { lanes: [search.lane] } : {}),
    ...(search.reason ? { reasons: [search.reason] } : {}),
    ...(search.state ? { states: [search.state] } : {}),
    ...(search.kind ? { kinds: [search.kind] } : {}),
    ...(search.runId ? { runId: search.runId } : {}),
    ...(search.attention ? { needsAttention: true } : {}),
  };
}

const hasFilter = (search: QueueSearch) =>
  Boolean(
    search.lane ||
    search.reason ||
    search.state ||
    search.kind ||
    search.runId ||
    search.attention,
  );

/**
 * The watchdog's verdict: nothing while healthy, else one red badge and the
 * raw numbers each alert tripped on.
 */
function QueueHealthNotice({
  health,
}: {
  health: QueueHealthSnapshot | null | undefined;
}) {
  if (!health?.alerts.length) return null;
  return (
    <div className="grid gap-1.5" data-testid="queue-health">
      <Row gap="sm" align="center" wrap>
        <Badge variant="destructive">
          <WarningIcon aria-hidden className="size-3" />
          Queue unhealthy · {countLabel(health.alerts.length, "alert")}
        </Badge>
        <span className="text-xs text-muted-foreground">
          Measured {formatRelative(health.measuredAt)}
          {health.imageDisagreement
            ? ` · ${formatCount(health.imageDisagreement)} image rows disagree with their Job`
            : ""}
        </span>
      </Row>
      <ul className="grid gap-0.5 font-mono text-xs/4.5 text-destructive">
        {health.alerts.map((alert) => (
          <li key={`${alert.kind ?? "all"}:${alert.code}`}>
            {alert.kind ?? "all kinds"} · {alert.code}: {alert.evidence}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Live Jobs grouped by lane, then by what they wait on. Each count opens the
 * filtered Job list below; the Apple lane also names the devices holding
 * leases (expired ones flagged) and how many active installs can pull.
 */
function QueueSummary({ search }: { search: QueueSearch }) {
  const all = useQuery(job.queue.queryOptions({ filter: {}, pageSize: 1 }));
  const attention = useQuery(
    job.queue.queryOptions({
      filter: { needsAttention: true },
      pageSize: 1,
    }),
  );
  const apple = useQuery(
    job.queue.queryOptions({
      filter: { lanes: ["apple_device"], reasons: ["leased"] },
      pageSize: 1,
    }),
  );
  const devices = useQuery(
    entityListFor("device").queryOptions({
      filters: {},
      pagination: { pageIndex: 0, pageSize: 50 },
    }),
  );
  if (all.isPending) return <RecordList state={{ status: "pending" }} />;
  if (all.isError)
    return (
      <RecordList
        state={{
          status: "error",
          error: all.error,
          title: "Couldn't load the queues",
          onRetry: () => void all.refetch(),
        }}
      />
    );
  const active = (devices.data?.items ?? []).filter(
    (device) => !device.inactive,
  );
  const outdated = active.filter((device) => device.updateRequired).length;
  const lanes = LANES.map((lane) => ({
    lane,
    rows: jobWaitingOnReason.options.flatMap((reason) => {
      const count =
        all.data.counts.find(
          (entry) => entry.lane === lane && entry.reason === reason,
        )?.count ?? 0;
      return count ? [{ reason, count }] : [];
    }),
  })).filter((entry) => entry.rows.length || entry.lane === "apple_device");
  const attentionCount = attention.data?.total ?? 0;
  return (
    <RecordList
      empty={<span>No live Jobs.</span>}
      footer={
        attentionCount ? (
          <QueueLink search={{ attention: true }} active={search.attention}>
            <span className="text-destructive">
              {countLabel(attentionCount, "Job")} need attention (still
              retrying)
            </span>
          </QueueLink>
        ) : null
      }
    >
      {lanes.map(({ lane, rows }) => (
        <RecordGroup
          key={lane}
          label={JOB_LANE_LABEL[lane]}
          count={rows.reduce((sum, row) => sum + row.count, 0)}
        >
          {lane === "apple_device" ? (
            <RecordRow
              primary={
                <span className="text-muted-foreground">
                  {countLabel(active.length, "active Apple device")}
                  {outdated ? ` · ${outdated} need an update` : ""}
                </span>
              }
              trailing={
                <Link to="/devices" className="text-link hover:underline">
                  Devices
                </Link>
              }
            />
          ) : null}
          {rows.map(({ reason, count }) => (
            <RecordRow
              key={reason}
              primary={
                <QueueLink
                  search={{ lane, reason }}
                  active={search.lane === lane && search.reason === reason}
                >
                  {JOB_WAITING_ON_LABEL[reason]}
                </QueueLink>
              }
              trailing={
                <span className="font-mono tabular-nums">
                  {formatCount(count)}
                </span>
              }
              detail={
                lane === "apple_device" && reason === "leased" ? (
                  <ul className="grid gap-0.5 text-xs/4.5">
                    {(apple.data?.leases ?? []).map((lease) => (
                      <li
                        key={lease.executor ?? "unknown"}
                        className="flex flex-wrap items-baseline gap-2"
                      >
                        <span>{lease.executor ?? "Unnamed device"}</span>
                        {lease.live ? (
                          <span className="text-muted-foreground">
                            <span className="font-mono tabular-nums">
                              {formatCount(lease.live)}
                            </span>{" "}
                            in progress
                          </span>
                        ) : null}
                        {lease.expired ? (
                          <Badge variant="warning">
                            {countLabel(lease.expired, "expired lease")}
                          </Badge>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null
              }
            />
          ))}
        </RecordGroup>
      ))}
    </RecordList>
  );
}

function QueueLink({
  search,
  active,
  children,
}: {
  search: QueueSearch;
  active?: boolean | undefined;
  children: React.ReactNode;
}) {
  return (
    <Link
      to="/activity"
      search={search}
      hash="queue-jobs"
      aria-current={active ? "true" : undefined}
      className="text-link hover:underline aria-[current=true]:font-semibold"
    >
      {children}
    </Link>
  );
}

const LANE_OPTIONS = LANES.map((value) => ({
  value,
  label: JOB_LANE_LABEL[value],
}));
const REASON_OPTIONS = jobWaitingOnReason.options.map((value) => ({
  value,
  label: JOB_WAITING_ON_LABEL[value],
}));
const STATE_OPTIONS = jobState.options.map((value) => ({
  value,
  label: value.replaceAll("_", " "),
}));

/**
 * One page of the filtered Job set with Retry now over the whole set and a
 * per-Job explain chain.
 */
function JobQueueList({
  search,
  onSearchChange,
}: {
  search: QueueSearch;
  onSearchChange: (next: Partial<QueueSearch>) => void;
}) {
  const filter = queueFilterOf(search);
  const pageIndex = search.page ?? 0;
  const queue = useQuery(
    job.queue.queryOptions({ filter, pageIndex, pageSize: PAGE_SIZE }),
  );
  const [confirming, setConfirming] = useState(false);
  const retry = useMutation(
    job.retryNow.mutationOptions({
      onSuccess: ({ retried }) =>
        toast.success(`Retry now: ${countLabel(retried, "Job")} made due`),
      onError: (error) => showErrorToast(error, "Retry now failed"),
    }),
  );
  const total = queue.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const chips = [
    search.kind ? { key: "kind", label: `Kind ${search.kind}` } : null,
    search.runId ? { key: "runId", label: `Run ${search.runId}` } : null,
    search.attention ? { key: "attention", label: "Needs attention" } : null,
  ].filter((chip) => chip !== null);
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center" wrap>
        <Picker
          mode="choose"
          compact
          clearable
          className="w-44"
          aria-label="Lane"
          placeholder="Any lane"
          options={LANE_OPTIONS}
          value={search.lane ?? null}
          onValueChange={(value) =>
            onSearchChange({
              lane: jobLane.safeParse(value).data,
              page: undefined,
            })
          }
        />
        <Picker
          mode="choose"
          compact
          clearable
          className="w-56"
          aria-label="Waiting on"
          placeholder="Any wait"
          options={REASON_OPTIONS}
          value={search.reason ?? null}
          onValueChange={(value) =>
            onSearchChange({
              reason: jobWaitingOnReason.safeParse(value).data,
              page: undefined,
            })
          }
        />
        <Picker
          mode="choose"
          compact
          clearable
          className="w-36"
          aria-label="State"
          placeholder="Live states"
          options={STATE_OPTIONS}
          value={search.state ?? null}
          onValueChange={(value) =>
            onSearchChange({
              state: jobState.safeParse(value).data,
              page: undefined,
            })
          }
        />
        {chips.map((chip) => (
          <Badge key={chip.key} variant="outline">
            {chip.label}
            <button
              type="button"
              aria-label={`Remove ${chip.label}`}
              className="-mr-1 ml-0.5 rounded-sm hover:bg-muted"
              onClick={() =>
                onSearchChange({ [chip.key]: undefined, page: undefined })
              }
            >
              <XIcon aria-hidden className="size-3" />
            </button>
          </Badge>
        ))}
        {hasFilter(search) ? (
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
            Clear
          </Button>
        ) : null}
        <span className="grow" />
        <Button
          variant="outline"
          size="sm"
          disabled={!total || retry.isPending}
          onClick={() => setConfirming(true)}
        >
          <ArrowClockwiseIcon aria-hidden />
          Retry now
        </Button>
      </Row>
      <RecordList
        state={
          queue.isPending
            ? { status: "pending", rows: 6 }
            : queue.isError
              ? {
                  status: "error",
                  error: queue.error,
                  title: "Couldn't load Jobs",
                  onRetry: () => void queue.refetch(),
                }
              : { status: "success" }
        }
        empty={<span>No Jobs match.</span>}
        footer={
          pages > 1 ? (
            <Row gap="sm" align="center">
              <Button
                variant="ghost"
                size="sm"
                disabled={pageIndex === 0}
                onClick={() =>
                  onSearchChange({ page: pageIndex - 1 || undefined })
                }
              >
                Previous
              </Button>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {pageIndex + 1} / {pages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={pageIndex + 1 >= pages}
                onClick={() => onSearchChange({ page: pageIndex + 1 })}
              >
                Next
              </Button>
            </Row>
          ) : null
        }
      >
        {queue.data?.jobs.map((facts) => (
          <JobRow key={facts.id} facts={facts} />
        ))}
      </RecordList>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Retry {countLabel(total, "Job", { formatted: true })} now?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every queued, backing-off or failed Job in this filter becomes due
              immediately and failed Jobs get a fresh attempt budget. Running
              and paused Jobs are left alone; earlier errors are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                retry.mutate({ filter });
              }}
            >
              Retry now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Stack>
  );
}

function JobRow({ facts }: { facts: JobFacts }) {
  const waiting = describeJobWaitingOn(facts.waitingOn);
  const expired =
    facts.waitingOn?.reason === "leased" && facts.waitingOn.expired;
  return (
    <RecordRow
      data-testid="queue-job"
      primary={
        <>
          <span className="font-mono text-xs">{facts.kind}</span>
          <JobStatePill state={facts.state} />
          {expired ? <Badge variant="warning">Lease expired</Badge> : null}
        </>
      }
      secondary={
        <>
          {waiting ?? "Finished"}
          {facts.runId ? (
            <>
              {" · "}
              {/* A plain code link: a page of Jobs must not read each Run. */}
              <a
                href={runHref(facts.runId)}
                className="font-mono text-link hover:underline"
              >
                {facts.runId}
              </a>
            </>
          ) : null}
        </>
      }
      trailing={
        <span title={facts.updatedAt}>
          {facts.attempts ? `${countLabel(facts.attempts, "failure")} · ` : ""}
          {formatRelative(facts.updatedAt)}
        </span>
      }
      detail={
        <RecordDetail summary="Explain">
          <JobExplain id={facts.id} error={facts.error} />
        </RecordDetail>
      }
    />
  );
}

/** `job.explain` for one Job: the chain from it to the Run it serves. */
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
          {describeJobRollup(rollup.counts) ?? "no live Jobs"}
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

const ATTENTION_STATUSES = [
  "running",
  "paused",
  "paused_auth",
  "needs_review",
] as const;

/**
 * Member-visible Runs that are stopped, waiting or stalled, with what their
 * live Jobs wait on. A Run whose open work moved to a retry reads Retried and
 * leaves this list.
 */
function RunsNeedingAttention() {
  const runs = useQuery(
    entityListFor("run").queryOptions({
      filters: {
        status: [...ATTENTION_STATUSES],
        purpose: [...VISIBLE_RUN_PURPOSES],
      },
      pagination: { pageIndex: 0, pageSize: 50 },
      sort: [{ orderBy: "startedAt", direction: "desc" }],
    }),
  );
  const rows = (runs.data?.items ?? []).filter(
    (row) =>
      row.displayStatus !== "retried" &&
      (row.displayStatus !== "running" || row.stalled),
  );
  return (
    <RecordList
      state={
        runs.isPending
          ? { status: "pending", rows: 3 }
          : runs.isError
            ? {
                status: "error",
                error: runs.error,
                title: "Couldn't load Runs",
                onRetry: () => void runs.refetch(),
              }
            : { status: "success" }
      }
      empty={<span>No Run needs attention.</span>}
    >
      {rows.map((row) => (
        <RecordRow
          key={row.id}
          data-testid="attention-run"
          primary={
            <>
              <EntityRefLink entity="run" id={row.id} name={row.displayName} />
              {row.stalled ? <Badge variant="warning">Stalled</Badge> : null}
            </>
          }
          secondary={row.waitingOn ?? "No live Jobs"}
          trailing={
            <Link
              to="/activity"
              search={{ runId: row.id }}
              hash="queue-jobs"
              className="text-link hover:underline"
            >
              Jobs
            </Link>
          }
        />
      ))}
    </RecordList>
  );
}

/** The queue part of Activity: health, lanes, Runs, then the Job list. */
export function QueueOverview({
  search,
  onSearchChange,
}: {
  search: QueueSearch;
  onSearchChange: (next: Partial<QueueSearch>) => void;
}) {
  const health = useQuery(job.health.queryOptions({}));
  return (
    <Stack gap="lg">
      <QueueHealthNotice health={health.data} />
      <Section
        headingAs="h2"
        title="Queues"
        caption="Live Jobs by who runs them and what they wait on."
      >
        <QueueSummary search={search} />
      </Section>
      <Section headingAs="h2" title="Runs needing attention">
        <RunsNeedingAttention />
      </Section>
      <Section headingAs="h2" title="Jobs" id="queue-jobs">
        <JobQueueList search={search} onSearchChange={onSearchChange} />
      </Section>
    </Stack>
  );
}

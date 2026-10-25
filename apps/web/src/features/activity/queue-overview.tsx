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
import {
  runPurpose,
  runStatus,
  VISIBLE_RUN_PURPOSES,
} from "@cubby/schemas/run-fields";
import { countLabel } from "@cubby/shared/pluralize";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import type {
  JobFacts,
  JobSetFilter,
  QueueHealthSnapshot,
} from "~/contracts/job.contract";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entityListFor } from "~/entity/entity-list";
import { viewsForEntity } from "~/entity/model/view-manifest";
import { runHref } from "~/entity/routing/purchase-import-links";
import { hasDisplayImages } from "~/entity/table/column-helpers";
import { job } from "~/integrations/tanstack-query/generated/catalog/job.gen";
import { formatRelative } from "~/lib/date-format";
import { formatMinutesSeconds } from "~/lib/format-duration";
import { formatCount } from "~/lib/number-format";
import { roundTo } from "~/lib/round-to";
import { cn } from "~/lib/utils";
import { Picker } from "~/ui/combobox/picker";
import {
  RecordDetail,
  RecordGroup,
  RecordList,
  RecordRow,
} from "~/ui/common/record-list";
import { showErrorToast } from "~/ui/feedback/error-details";
import { Panel, Row, Section, Stack } from "~/ui/layout";
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
import { Image } from "~/ui/primitives/image";
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

/**
 * The Run entity's declared "Needs attention" saved view: the one statement of
 * which stopped Runs need the member (Apple reads the same declaration).
 */
const ATTENTION_FILTERS = (() => {
  const view = viewsForEntity("run").find(({ id }) => id === "attention");
  if (!view) throw new Error("Run declares no attention saved view");
  return {
    status: runStatus
      .array()
      .parse(view.filters.find(({ id }) => id === "status")?.value),
    purpose: runPurpose
      .array()
      .parse(view.filters.find(({ id }) => id === "purpose")?.value),
  };
})();

const ATTENTION_PAGE = { pageIndex: 0, pageSize: 50 };

/**
 * Member-visible Runs that are stopped, waiting or stalled, with what their
 * live Jobs wait on: the declared attention view plus running Runs whose
 * server-derived `stalled` flag is set. A Run whose open work moved to a
 * retry reads Retried and leaves this list.
 */
function RunsNeedingAttention() {
  const list = entityListFor("run");
  const stopped = useQuery(
    list.queryOptions({
      filters: ATTENTION_FILTERS,
      pagination: ATTENTION_PAGE,
      sort: [{ orderBy: "startedAt", direction: "desc" }],
    }),
  );
  const running = useQuery(
    list.queryOptions({
      filters: { status: ["running"], purpose: [...VISIBLE_RUN_PURPOSES] },
      pagination: ATTENTION_PAGE,
      sort: [{ orderBy: "startedAt", direction: "desc" }],
    }),
  );
  const rows = [
    ...(stopped.data?.items ?? []).filter(
      (row) => row.displayStatus !== "retried",
    ),
    ...(running.data?.items ?? []).filter((row) => row.stalled),
  ];
  const failed = stopped.isError ? stopped : running.isError ? running : null;
  return (
    <RecordList
      state={
        stopped.isPending || running.isPending
          ? { status: "pending", rows: 3 }
          : failed
            ? {
                status: "error",
                error: failed.error,
                title: "Couldn't load Runs",
                onRetry: () => void failed.refetch(),
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

/**
 * Parked Apple-device work at a glance: what waits, which devices are
 * working it and when it drains at their current pace. Silent once nothing
 * waits; loud when work waits and no device is pulling.
 */
/** Whole minutes under an hour, then hours and minutes, then days. */
const formatEta = (seconds: number) => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.round(hours / 24)} days`;
};

function DeviceBacklogNotice() {
  const backlog = useQuery(job.deviceBacklog.queryOptions({}));
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

const PROCESSING_PAGE = { pageIndex: 0, pageSize: 50 };

/** A per-second clock for lease countdowns (leases last 60 s). */
function useSecondClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Image jobs an Apple device holds a live lease on, grouped by device: the
 * generic imageJob rows (thumbnail, job, Run) with each lease's countdown.
 * Expired leases of old installs stay counted per executor in Queues.
 */
function ImageJobsProcessing() {
  const processing = useQuery(
    entityListFor("imageJob").queryOptions({
      filters: { state: ["leased"] },
      pagination: PROCESSING_PAGE,
      sort: [{ orderBy: "createdAt", direction: "asc" }],
    }),
  );
  const devices = useQuery(
    entityListFor("device").queryOptions({
      filters: {},
      pagination: { pageIndex: 0, pageSize: 50 },
    }),
  );
  const now = useSecondClock();
  const rows = processing.data?.items ?? [];
  const deviceName = new Map<string, string>(
    (devices.data?.items ?? []).map((device) => [device.id, device.name]),
  );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const device = row.leaseDeviceId ?? "";
    groups.set(device, [...(groups.get(device) ?? []), row]);
  }
  return (
    <RecordList
      state={
        processing.isPending
          ? { status: "pending", rows: 3 }
          : processing.isError
            ? {
                status: "error",
                error: processing.error,
                title: "Couldn't load image jobs",
                onRetry: () => void processing.refetch(),
              }
            : { status: "success" }
      }
      empty={<span>No Apple device is processing image work right now.</span>}
      footer={
        (processing.data?.meta.totalCount ?? 0) > rows.length ? (
          <Link
            to="/image-jobs"
            search={{ state: "leased" }}
            className="text-link hover:underline"
          >
            All {formatCount(processing.data?.meta.totalCount ?? 0)} processing
          </Link>
        ) : null
      }
    >
      {[...groups].map(([device, jobs]) => (
        <RecordGroup
          key={device || "unknown"}
          label={
            device ? (
              <EntityRefLink
                entity="device"
                id={device}
                name={deviceName.get(device) ?? device}
              />
            ) : (
              "Unregistered device"
            )
          }
          count={jobs.length}
        >
          {jobs.map((row) => {
            const image = hasDisplayImages(row) ? row.displayImages[0] : null;
            const remaining = row.leaseExpiresAt
              ? new Date(row.leaseExpiresAt).getTime() - now
              : null;
            return (
              <RecordRow
                key={row.id}
                data-testid="processing-image-job"
                leading={
                  image ? (
                    <Image
                      src={image.url}
                      alt=""
                      displayWidth={96}
                      className="size-10 rounded-md border border-border object-cover"
                    />
                  ) : null
                }
                primary={
                  <EntityRefLink
                    entity="imageJob"
                    id={row.id}
                    name={row.displayName}
                  />
                }
                secondary={
                  row.runId ? (
                    <EntityRefLink entity="run" id={row.runId} />
                  ) : (
                    "Background maintenance"
                  )
                }
                trailing={
                  remaining === null ? null : (
                    <span
                      className={cn(
                        "font-mono text-xs tabular-nums",
                        remaining <= 0
                          ? "text-warning"
                          : "text-muted-foreground",
                      )}
                    >
                      {remaining <= 0
                        ? "lease lapsed"
                        : `lease ${formatMinutesSeconds(remaining)}`}
                    </span>
                  )
                }
              />
            );
          })}
        </RecordGroup>
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
      <QueueHealthNotice health={health.data?.snapshot} />
      <DeviceBacklogNotice />
      <Section
        headingAs="h2"
        title="Queues"
        caption="Live Jobs by who runs them and what they wait on."
      >
        <QueueSummary search={search} />
      </Section>
      <Section
        headingAs="h2"
        title="Apple devices processing"
        caption="Image jobs a device holds a lease on; it renews every 15 seconds, and a lapsed lease lets any device take the job."
      >
        <ImageJobsProcessing />
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

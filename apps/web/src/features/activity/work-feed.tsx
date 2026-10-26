import { countLabel } from "@cubby/shared/pluralize";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { HourglassIcon } from "@phosphor-icons/react/dist/csr/Hourglass";
import { PauseIcon } from "@phosphor-icons/react/dist/csr/Pause";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { derived } from "~/integrations/tanstack-query/generated/catalog/derived.gen";
import { job } from "~/integrations/tanstack-query/generated/catalog/job.gen";
import { formatRelative } from "~/lib/date-format";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { Section } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";

import {
  formatMinutesLeft,
  formatPace,
  orderWorkStreams,
  type WorkStreamStatus,
  type WorkStreamView,
  workStreamView,
} from "./work-streams";

const POLL_MS = 10_000;

const STATUS_LABEL = {
  working: "Working",
  waiting: "Waiting",
  stuck: "Not moving",
  backing_off: "Backing off",
  paused: "Paused",
  done: "Done",
} satisfies Record<WorkStreamStatus, string>;

function StatusGlyph({ status }: { status: WorkStreamStatus }) {
  const label = STATUS_LABEL[status];
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "working":
      return <Spinner size="sm" aria-label={label} className="text-info" />;
    case "stuck":
      return (
        <WarningIcon
          aria-label={label}
          className={cn(className, "text-warning-ink")}
        />
      );
    case "backing_off":
      return (
        <ArrowClockwiseIcon
          aria-label={label}
          className={cn(className, "text-warning-ink")}
        />
      );
    case "paused":
      return (
        <PauseIcon
          aria-label={label}
          className={cn(className, "text-muted-foreground")}
        />
      );
    case "done":
      return (
        <CheckCircleIcon
          aria-label={label}
          className={cn(className, "text-positive")}
        />
      );
    default:
      return (
        <HourglassIcon
          aria-label={label}
          className={cn(className, "text-muted-foreground")}
        />
      );
  }
}

const duration = (seconds: number) =>
  seconds < 90
    ? `${seconds} s`
    : seconds < 90 * 60
      ? `${Math.round(seconds / 60)} min`
      : `${Math.round(seconds / 3600)} h`;

/** What is happening inside the stream, in the order a member asks. */
function streamFacts(view: WorkStreamView, failedMinutes: number) {
  const { stream } = view;
  const parts: string[] = [];
  if (stream.running) parts.push(`${formatCount(stream.running)} running`);
  if (stream.due)
    parts.push(
      `${formatCount(stream.due)} waiting${
        view.oldestWaitSeconds !== null && view.oldestWaitSeconds >= 60
          ? ` (oldest ${duration(view.oldestWaitSeconds)})`
          : ""
      }`,
    );
  if (stream.backingOff)
    parts.push(`${formatCount(stream.backingOff)} backing off`);
  if (stream.scheduled)
    parts.push(`${formatCount(stream.scheduled)} scheduled`);
  if (stream.paused) parts.push(`${formatCount(stream.paused)} paused`);
  if (stream.failed)
    parts.push(`${formatCount(stream.failed)} failed in ${failedMinutes} min`);
  return parts.join(" · ");
}

function streamPace(
  view: WorkStreamView,
  completedMinutes: number,
  now: number,
) {
  const { stream } = view;
  if (stream.completedPerMinute > 0)
    return [
      formatPace(stream.completedPerMinute),
      view.minutesLeft !== null
        ? `${formatMinutesLeft(view.minutesLeft)} left`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  if (stream.completed)
    return `${formatCount(stream.completed)} done in ${completedMinutes} min`;
  if (stream.lastCompletedAt)
    return `Last finished ${formatRelative(stream.lastCompletedAt, now)}`;
  return null;
}

/**
 * The Activity page's "Now": one row per kind of work, in plain words, with
 * whether it moves, how fast, and what it waits on. Pace is measured over
 * the last few minutes; time left is that pace applied to what remains.
 */
export function WorkFeed({
  onShowJobs,
}: {
  onShowJobs: (kind: string) => void;
}) {
  const activity = useQuery({
    ...job.activity.queryOptions({}),
    refetchInterval: POLL_MS,
  });
  const backlog = useQuery({
    ...derived.backlog.queryOptions({}),
    refetchInterval: POLL_MS,
  });
  const now = activity.dataUpdatedAt || Date.now();
  const views = activity.data
    ? orderWorkStreams(
        activity.data.streams.map((stream) => workStreamView(stream, now)),
      )
    : [];
  const live = views.filter((view) => view.status !== "done");
  const finished = views.filter((view) => view.status === "done");
  const windows = activity.data?.windows;
  const derivedRecent = backlog.data?.recent.perMinute ?? [];
  const derivedUpdated = derivedRecent.reduce((sum, n) => sum + n, 0);
  const derivedPace =
    derivedRecent.slice(-5).reduce((sum, n) => sum + n, 0) / 5;
  const derivedWaiting = backlog.data?.total ?? 0;
  const completedTotal = views.reduce(
    (sum, view) => sum + view.stream.completed,
    0,
  );
  const caption = !activity.data
    ? undefined
    : live.length
      ? `${countLabel(live.length, "kind")} of work in progress · ${formatCount(completedTotal + derivedUpdated)} finished in the last ${windows?.completedMinutes ?? 15} min`
      : `All quiet · ${formatCount(completedTotal + derivedUpdated)} finished in the last ${windows?.completedMinutes ?? 15} min`;

  return (
    <Section headingAs="h2" title="Now" caption={caption} id="now">
      <RecordList
        state={
          activity.isPending
            ? { status: "pending", rows: 4 }
            : activity.isError
              ? {
                  status: "error",
                  error: activity.error,
                  title: "Couldn't load current work",
                  onRetry: () => void activity.refetch(),
                }
              : { status: "success" }
        }
        empty={<span>Nothing running or waiting.</span>}
      >
        {backlog.data && (derivedWaiting > 0 || derivedUpdated > 0) ? (
          <RecordRow
            data-testid="work-stream-derived"
            leading={
              <StatusGlyph
                status={
                  derivedWaiting === 0
                    ? "done"
                    : derivedPace > 0
                      ? "working"
                      : (backlog.data.oldestWaitingSeconds ?? 0) >= 600
                        ? "stuck"
                        : "waiting"
                }
              />
            }
            primary={
              <a href="#derived-values" className="hover:underline">
                Derived values
              </a>
            }
            secondary={
              derivedWaiting
                ? `${formatCount(derivedWaiting)} waiting${
                    (backlog.data.oldestWaitingSeconds ?? 0) >= 60
                      ? ` (oldest ${duration(backlog.data.oldestWaitingSeconds ?? 0)})`
                      : ""
                  }`
                : "Up to date"
            }
            trailing={`${formatCount(derivedUpdated)} updated in ${backlog.data.recent.windowMinutes} min`}
          />
        ) : null}
        {[...live, ...finished].map((view) => {
          const facts = streamFacts(view, windows?.failedMinutes ?? 60);
          return (
            <RecordRow
              key={view.key}
              data-testid="work-stream"
              leading={<StatusGlyph status={view.status} />}
              primary={
                <span
                  className={cn(
                    view.status === "done" && "text-muted-foreground",
                  )}
                >
                  {view.label}
                </span>
              }
              secondary={facts || undefined}
              trailing={
                streamPace(view, windows?.completedMinutes ?? 15, now) ??
                undefined
              }
              actions={
                <>
                  {view.stream.runIds.map((code) => (
                    <Link
                      key={code}
                      to="/runs/$shortcode"
                      params={{ shortcode: code }}
                      className="font-mono text-xs text-link hover:underline"
                    >
                      {code}
                    </Link>
                  ))}
                  {view.status !== "done" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onShowJobs(view.stream.kind)}
                    >
                      Jobs
                    </Button>
                  ) : null}
                </>
              }
            />
          );
        })}
      </RecordList>
    </Section>
  );
}

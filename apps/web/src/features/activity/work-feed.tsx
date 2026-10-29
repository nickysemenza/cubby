import { countLabel } from "@cubby/shared/pluralize";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { HourglassIcon } from "@phosphor-icons/react/dist/csr/Hourglass";
import { PauseIcon } from "@phosphor-icons/react/dist/csr/Pause";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { derived } from "~/integrations/tanstack-query/generated/domains/derived.gen";
import { job } from "~/integrations/tanstack-query/generated/domains/job.gen";
import { formatRelative } from "~/lib/date-format";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
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
  failed: "Failed",
  stale: "Data out of date",
  backing_off: "Backing off",
  paused: "Paused",
  done: "Done",
} satisfies Record<WorkStreamStatus, string>;

function StatusGlyph({ status }: { status: WorkStreamStatus }) {
  const label = STATUS_LABEL[status];
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "failed":
      return (
        <WarningCircleIcon
          aria-label={label}
          className={cn(className, "text-destructive")}
        />
      );
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
  if (["paused", "stuck", "failed", "stale"].includes(view.status)) return null;
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
// eslint-disable-next-line complexity -- Feed freshness, caption and row states must use the same query snapshots.
export function WorkFeed({
  onShowJobs,
  attentionOnly = false,
}: {
  attentionOnly?: boolean;
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
  const now = useDisplayNow() ?? Date.now();
  const activityStale = Boolean(
    activity.data && now - Date.parse(activity.data.measuredAt) > 3 * POLL_MS,
  );
  // Backlog has no measurement timestamp; age its last successful read instead.
  const backlogStale = Boolean(
    backlog.data && now - backlog.dataUpdatedAt > 3 * POLL_MS,
  );
  const unknown =
    !activity.data ||
    activity.isError ||
    activityStale ||
    !backlog.data ||
    backlog.isError ||
    backlogStale;
  const views = activity.data
    ? orderWorkStreams(
        activity.data.streams.map((stream) => {
          const view = workStreamView(stream, now);
          return activityStale
            ? { ...view, status: "stale" as const, minutesLeft: null }
            : view;
        }),
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
  const derivedStatus: WorkStreamStatus = backlogStale
    ? "stale"
    : derivedWaiting === 0
      ? "done"
      : derivedPace > 0
        ? "working"
        : (backlog.data?.oldestWaitingSeconds ?? 0) >= 600
          ? "stuck"
          : "waiting";
  const working =
    (!activity.isError && views.some((view) => view.status === "working")) ||
    (!backlog.isError && derivedStatus === "working");
  const activeCount =
    live.filter((view) => view.status !== "paused").length +
    (derivedWaiting > 0 ? 1 : 0);
  const caption = unknown
    ? "Current work status unavailable"
    : activeCount
      ? `${countLabel(activeCount, "kind")} of work in progress · ${formatCount(completedTotal + derivedUpdated)} finished in the last ${windows?.completedMinutes ?? 15} min`
      : `All quiet · ${formatCount(completedTotal + derivedUpdated)} finished in the last ${windows?.completedMinutes ?? 15} min`;

  const visibleViews = attentionOnly
    ? live.filter(
        (view) =>
          view.status === "stuck" ||
          view.status === "failed" ||
          view.status === "stale",
      )
    : [...live, ...finished];
  const showDerived =
    !attentionOnly || derivedStatus === "stuck" || derivedStatus === "stale";
  return (
    <Section
      headingAs={attentionOnly ? "h3" : "h2"}
      title={
        attentionOnly ? (
          "Stalled or failed work"
        ) : (
          <span className="inline-flex items-center gap-2">
            Now
            {working ? (
              <>
                <span
                  aria-hidden
                  className="size-1.5 rounded-full bg-info motion-safe:animate-pulse"
                />
                <span className="sr-only">Work is moving</span>
              </>
            ) : null}
          </span>
        )
      }
      caption={
        attentionOnly
          ? unknown
            ? "Problem status unavailable"
            : "Work that has stopped progressing or keeps failing. Ordinary retries and waits stay in Now."
          : caption
      }
      id={attentionOnly ? "attention-streams" : "now"}
    >
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
        empty={
          <span>
            {unknown
              ? "Current work status unavailable"
              : attentionOnly
                ? "No stalled or failed streams observed."
                : "All quiet · Nothing running or waiting."}
          </span>
        }
      >
        {backlog.isPending || backlog.isError ? (
          <RecordRow
            primary="Derived values"
            clip={false}
            detail={
              <RecordList
                state={
                  backlog.isPending
                    ? { status: "pending", rows: 1 }
                    : {
                        status: "error",
                        error: backlog.error,
                        title: "derived values",
                        onRetry: () => void backlog.refetch(),
                      }
                }
              />
            }
          />
        ) : showDerived &&
          ((backlog.data && (derivedWaiting > 0 || derivedUpdated > 0)) ||
            backlogStale) ? (
          <FeedRow
            testId="work-stream-derived"
            status={derivedStatus}
            label={
              attentionOnly ? (
                <Link
                  to="/activity"
                  search={{ tab: "now" }}
                  hash="derived-values"
                  className="hover:underline"
                >
                  Derived values
                </Link>
              ) : (
                <a href="#derived-values" className="hover:underline">
                  Derived values
                </a>
              )
            }
            facts={
              backlogStale
                ? `Data read ${formatRelative(backlog.dataUpdatedAt, now)}`
                : derivedWaiting
                  ? `${formatCount(derivedWaiting)} waiting${(backlog.data?.oldestWaitingSeconds ?? 0) >= 60 ? ` · oldest waiting ${duration(backlog.data?.oldestWaitingSeconds ?? 0)}` : ""}`
                  : "Up to date"
            }
            pace={
              backlog.data && !backlogStale
                ? `${formatCount(derivedUpdated)} updated in ${backlog.data.recent.windowMinutes} min`
                : null
            }
          />
        ) : null}
        {visibleViews.map((view) => {
          const facts =
            activityStale && activity.data
              ? `Data measured ${formatRelative(activity.data.measuredAt, now)}`
              : streamFacts(view, windows?.failedMinutes ?? 60);
          return (
            <FeedRow
              key={view.key}
              testId="work-stream"
              status={view.status}
              label={view.label}
              facts={facts}
              pace={streamPace(view, windows?.completedMinutes ?? 15, now)}
              actions={
                <>
                  {view.stream.runIds.slice(0, 3).map((code) => (
                    <Link
                      key={code}
                      to="/runs/$shortcode"
                      params={{ shortcode: code }}
                      className="inline-flex min-h-11 items-center font-mono text-xs text-link hover:underline sm:min-h-7"
                    >
                      {code}
                    </Link>
                  ))}
                  {view.stream.runIds.length > 3 ? (
                    <span className="font-mono text-xs text-muted-foreground">
                      +{view.stream.runIds.length - 3}
                    </span>
                  ) : null}
                  {view.status !== "done" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-11 sm:min-h-7"
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

/** Keep pace below identity on phone, and commands together below the facts. */
function FeedRow({
  status,
  label,
  facts,
  pace,
  actions,
  testId,
}: {
  status: WorkStreamStatus;
  label: ReactNode;
  facts: string;
  pace: string | null;
  actions?: ReactNode;
  testId: string;
}) {
  return (
    <RecordRow
      data-testid={testId}
      leading={<StatusGlyph status={status} />}
      primary={
        <div className="grid w-full min-w-0 gap-x-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span
              className={cn(
                "text-sm font-medium",
                status === "done" && "text-muted-foreground",
              )}
            >
              {label}
            </span>
            <span className="text-xs text-muted-foreground">
              {STATUS_LABEL[status]}
            </span>
          </div>
          {pace ? (
            <span className="text-xs text-muted-foreground tabular-nums sm:text-right">
              {pace}
            </span>
          ) : null}
          {facts ? (
            <span className="text-xs/5 text-muted-foreground sm:col-start-1">
              {facts}
            </span>
          ) : null}
          {actions ? (
            <div className="flex flex-wrap items-center gap-x-2 sm:col-start-2 sm:row-span-2 sm:row-start-2 sm:justify-end">
              {actions}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

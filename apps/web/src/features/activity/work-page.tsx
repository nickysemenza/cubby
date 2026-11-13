import {
  aboutSpanText,
  type WorkQueueUnit,
  type WorkQueueWait,
} from "@cubby/schemas/job";
import {
  AGENT_BACKLOG_INPUT,
  NEEDS_YOU_FILTERS,
} from "@cubby/schemas/work-queue";
import type { WorkStatus, WorkStuckItem } from "@cubby/schemas/work-status";
import { countLabel } from "@cubby/shared/pluralize";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { RetryJobsButton } from "~/features/job/retry-jobs";
import { hasIncompleteWorkInputs } from "~/features/work-queue/work-input-status";
import {
  WorkQueue,
  type WorkQueueMeta,
} from "~/features/work-queue/work-queue-page";
import { ai } from "~/integrations/tanstack-query/generated/domains/ai.gen";
import { job } from "~/integrations/tanstack-query/generated/domains/job.gen";
import { workQueue } from "~/integrations/tanstack-query/generated/domains/workQueue.gen";
import { copyTextWithToast } from "~/lib/clipboard";
import { formatRelative } from "~/lib/date-format";
import { formatCount } from "~/lib/number-format";
import { showErrorToast } from "~/ui/feedback/error-details";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
import { Section, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

/** Past this the list only counts the rest; a page of warnings stops being read. */
const STUCK_ROW_CAP = 8;
/** Retry shows its outcome without a reload, then the page goes quiet again. */
const RETRY_READ_MS = 10_000;
const RETRY_WATCH_MS = 2 * 60_000;

const STATUS_INPUT = {};

/** "2 background processes are stuck." and its peers: the page's always-on verdict. */
function healthSentence(status: WorkStatus, now: number) {
  const stuck = status.stuck.length;
  if (stuck)
    return stuck === 1
      ? "1 background process is stuck."
      : `${formatCount(stuck)} background processes are stuck.`;
  if (status.behind)
    return "Catching up. Some totals and search results may lag behind for a while. Nothing to do.";
  if (!status.lastFinishedAt) return "Background work is healthy.";
  const finished = formatRelative(status.lastFinishedAt, now);
  return `Background work is healthy. Last finished ${finished === "now" ? "just now" : finished}.`;
}

function TechnicalDetails({ text }: { text: string }) {
  return (
    <div className="col-start-2 -col-end-1">
      <Disclosure
        summary="Technical details"
        aside={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void copyTextWithToast(text, "Details copied")}
          >
            Copy
          </Button>
        }
      >
        <pre className="mt-1 max-h-[30vh] overflow-auto rounded-lg bg-destructive-surface px-2 py-1.5 font-mono text-xs/4 break-words whitespace-pre-wrap text-destructive">
          {text}
        </pre>
      </Disclosure>
    </div>
  );
}

function StuckAction({
  action,
  onRetried,
}: {
  action: WorkStuckItem["action"];
  onRetried: () => void;
}) {
  if (action.type === "retry")
    return (
      <RetryJobsButton
        filter={{
          kinds: action.kinds,
          ...(action.needsAttention ? { needsAttention: true } : {}),
        }}
        onRetried={onRetried}
      />
    );
  if (action.type === "link") {
    const url = new URL(action.href, "https://cubby.invalid");
    return (
      <Link
        to={url.pathname}
        search={Object.fromEntries(url.searchParams)}
        className="inline-flex items-center text-link hover:underline max-md:min-h-11"
      >
        {action.label}
      </Link>
    );
  }
  return null;
}

/** A warning glyph, what stopped in outcome words, and at most one action. */
function StuckRow({
  item,
  onRetried,
}: {
  item: WorkStuckItem;
  onRetried: () => void;
}) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-b border-border/60 py-2 md:grid-cols-[auto_minmax(0,1fr)_auto]">
      <WarningIcon
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-warning-ink"
      />
      <p className="font-medium text-foreground-strong">{item.title}</p>
      <div className="col-start-2 max-md:row-start-3 md:col-start-3 md:row-span-2 md:row-start-1">
        <StuckAction action={item.action} onRetried={onRetried} />
      </div>
      <p className="col-start-2 max-w-prose text-muted-foreground">
        {item.body}
      </p>
      {item.diagnostic ? <TechnicalDetails text={item.diagnostic} /> : null}
    </li>
  );
}

/**
 * The one list of background work that stopped or keeps failing, each row with
 * its retry, under the page's health verdict. Every stuck or failed kind,
 * device wait and stopped Run reads from `workQueue.status`.
 */
function BackgroundWork({
  sentence,
  items,
  onRetried,
}: {
  sentence: string;
  items: readonly WorkStuckItem[];
  onRetried: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Section
      headingAs="h2"
      title="Background work"
      count={items.length ? formatCount(items.length) : undefined}
      ruled
    >
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- The persistent health sentence is a paragraph. */}
      <p
        role="status"
        className="min-h-5.5 text-muted-foreground"
        data-testid="work-health"
      >
        {sentence}
      </p>
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
      <ul>
        {(expanded ? items : items.slice(0, STUCK_ROW_CAP)).map((item) => (
          <StuckRow key={item.key} item={item} onRetried={onRetried} />
        ))}
      </ul>
      {items.length > STUCK_ROW_CAP ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? "Show fewer"
            : `Show ${items.length - STUCK_ROW_CAP} more`}
        </Button>
      ) : null}
    </Section>
  );
}

const factClass = "font-mono text-xs text-muted-foreground tabular-nums";

/**
 * When a unit's due work drains at its recent pace: the pace is the whole
 * kind's, so it divides every group's count together. A funding wait ends
 * when the window reopens, whatever the pace, so it is left out.
 */
function drainText(
  waits: readonly WorkQueueWait[],
  perMinute: number,
  paceMinutes: number,
): string | null {
  const due = waits
    .filter((wait) => wait.reason !== "ai_funding_window")
    .reduce((sum, wait) => sum + wait.count, 0);
  if (!due) return null;
  return perMinute > 0
    ? `Drains in ${aboutSpanText((due / perMinute) * 60_000)} at the last ${paceMinutes} minutes' pace.`
    : `Pace unknown: none finished in the last ${paceMinutes} minutes.`;
}

/** One permit unit: its name, what the last hour did with it, and why its work waits. */
function QueueUnitRow({
  unit,
  now,
  perMinute,
  paceMinutes,
}: {
  unit: WorkQueueUnit;
  now: number;
  /** The unit's stream pace; 0 when none finished or it has no stream. */
  perMinute: number;
  paceMinutes: number;
}) {
  const page = unit.lastExecution;
  const drain = drainText(unit.waits, perMinute, paceMinutes);
  return (
    <li className="grid gap-x-4 gap-y-0.5 border-b border-border/60 py-2 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <div className="min-w-0">
        <p className="font-medium text-foreground-strong">{unit.label}</p>
        {unit.label === unit.unit ? null : (
          <p className={`${factClass} break-all`}>{unit.unit}</p>
        )}
      </div>
      <div className="min-w-0">
        <p className={factClass}>
          {formatCount(unit.claimed)} claimed · {formatCount(unit.succeeded)}{" "}
          finished · {formatCount(unit.deferred)} deferred ·{" "}
          {formatCount(unit.failed)} failed
        </p>
        <p className="text-muted-foreground">
          {unit.oldestDueAt
            ? `Oldest waiting work came due ${formatRelative(unit.oldestDueAt, now)}.`
            : "Nothing is due."}{" "}
          {unit.leased || unit.expiredLeases
            ? `${countLabel(unit.leased, "lease")} held${
                unit.expiredLeases
                  ? `, ${formatCount(unit.expiredLeases)} more expired`
                  : ""
              }.`
            : "No leases held."}
        </p>
        {page ? (
          <p className="text-muted-foreground">
            Last pass {page.outcome}
            {page.errorClass ? ` (${page.errorClass})` : ""}{" "}
            {formatRelative(page.finishedAt, now)}
            {page.items
              ? `: ${formatCount(page.items.claimed)} claimed, ${formatCount(page.items.published)} saved, ${formatCount(page.items.failed)} failed.`
              : "."}
          </p>
        ) : null}
        {unit.waits.map((wait) => (
          <p key={`${wait.reason}:${wait.runPurpose}`}>
            {wait.summary}
            {wait.runIds.map((id) => {
              const href: string = `/runs/${id}`;
              return (
                <Link
                  key={id}
                  to={href}
                  className="ml-2 font-mono text-xs text-link hover:underline"
                >
                  {id}
                </Link>
              );
            })}
          </p>
        ))}
        {drain ? <p className="text-muted-foreground">{drain}</p> : null}
      </div>
    </li>
  );
}

function QueueDetailsBody({ now }: { now: number }) {
  const activity = useQuery(job.activity.queryOptions(STATUS_INPUT));
  if (activity.isError && !activity.data)
    return (
      <div className="grid gap-1">
        <p className="text-muted-foreground">Couldn&apos;t read the queue.</p>
        <TechnicalDetails
          text={
            activity.error instanceof Error
              ? activity.error.message
              : String(activity.error)
          }
        />
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void activity.refetch()}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  const data = activity.data;
  if (!data) return <p className="text-muted-foreground">Reading the queue…</p>;
  return (
    <Stack gap="md">
      <div>
        <p className="max-w-prose text-muted-foreground">
          Each kind of background work over the last{" "}
          {formatCount(data.windows.outcomeMinutes)} minutes. Counts are Jobs by
          how they last ended, so a Job that deferred many times counts once.
        </p>
        {data.queue.length ? (
          <ul data-testid="queue-units">
            {data.queue.map((unit) => (
              <QueueUnitRow
                key={unit.unit}
                unit={unit}
                now={now}
                perMinute={
                  data.streams.find((stream) => stream.kind === unit.unit)
                    ?.completedPerMinute ?? 0
                }
                paceMinutes={data.windows.paceMinutes}
              />
            ))}
          </ul>
        ) : (
          <p className="py-2">Nothing ran or waited.</p>
        )}
      </div>
    </Stack>
  );
}

/** Never claims all clear: this page cannot tell whether work stopped. */
function UnknownStatus({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <Section headingAs="h2" title="Background status" ruled>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 py-2 md:grid-cols-[auto_minmax(0,1fr)_auto]">
        <WarningIcon
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0 text-warning-ink"
        />
        <p className="font-medium text-foreground-strong">Status read failed</p>
        <div className="col-start-2 max-md:row-start-3 md:col-start-3 md:row-span-2 md:row-start-1">
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
        <p className="col-start-2 max-w-prose text-muted-foreground">
          This doesn&apos;t mean work has stopped.
        </p>
        <TechnicalDetails
          text={error instanceof Error ? error.message : String(error)}
        />
      </div>
    </Section>
  );
}

/**
 * One queue, grouped by reason. It stays mounted while empty so a new item
 * appears without a reload. Its total and the sidebar's are the same
 * published population, so they agree once both have read it.
 */
function NeedsYouQueue() {
  const [total, setTotal] = useState<number>();
  const [incomplete, setIncomplete] = useState(false);
  const onMeta = useCallback((meta: WorkQueueMeta) => {
    setTotal(meta.totalCount);
    setIncomplete(hasIncompleteWorkInputs(meta));
  }, []);
  const empty = total === 0 && !incomplete;
  return (
    <>
      {empty ? (
        <p className="text-base/5 font-medium text-foreground-strong">
          Nothing needs you.
        </p>
      ) : null}
      <div hidden={empty}>
        <Section
          headingAs="h2"
          title="Needs you"
          count={total === undefined ? undefined : formatCount(total)}
        >
          <WorkQueue
            scope={NEEDS_YOU_FILTERS}
            groupBy="reason"
            label="Needs you"
            onMeta={onMeta}
          />
        </Section>
      </div>
    </>
  );
}

/**
 * Agent work never needs the member, so it is one quiet link with its size
 * and no badge. It opens the queue's Agent view, newest first.
 */
function AgentBacklogLink() {
  const backlog = useQuery({
    ...workQueue.queue.queryOptions(AGENT_BACKLOG_INPUT),
    refetchInterval: false,
  });
  const count = backlog.data?.meta.totalCount;
  return (
    <Link to="/work-queue" search={{ view: "agent" }}>
      Agent backlog
      {count ? (
        <span className="text-muted-foreground tabular-nums">
          {" "}
          <span aria-hidden="true">·</span> {formatCount(count)}
        </span>
      ) : null}
    </Link>
  );
}

/** Automatic AI work has no Run to stop, so its Stop lives here. */
function useAutomaticWork() {
  const state = useQuery(ai.automaticWork.queryOptions({}));
  const options = {
    onSuccess: () => void state.refetch(),
    onError: (error: Error) =>
      showErrorToast(error, "Automatic AI work didn't change"),
  };
  return {
    stoppedAt: state.data?.stoppedAt,
    stop: useMutation(ai.stopAutomaticWork.mutationOptions(options)),
    resume: useMutation(ai.resumeAutomaticWork.mutationOptions(options)),
  };
}

/** Nothing else on the page would show that this work is stopped, so it says so plainly. */
function AutomaticWorkStopped({
  stoppedAt,
  now,
  resume,
}: {
  stoppedAt: string;
  now: number;
  resume: ReturnType<typeof useAutomaticWork>["resume"];
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
      data-testid="automatic-work-stopped"
    >
      <p className="max-w-prose text-foreground-strong">
        Automatic AI work stopped {formatRelative(stoppedAt, now)}. Refresh
        waits until you resume.
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={resume.isPending}
        onClick={() => resume.mutate({})}
      >
        {resume.isPending ? "Resuming…" : "Resume"}
      </Button>
    </div>
  );
}

/** One verdict and one queue; queue telemetry stays behind a closed disclosure. */
export function WorkPage({ fromRetiredJobs }: { fromRetiredJobs: boolean }) {
  const [watchUntil, setWatchUntil] = useState(0);
  const status = useQuery({
    ...workQueue.status.queryOptions(STATUS_INPUT),
    refetchInterval: () => (Date.now() < watchUntil ? RETRY_READ_MS : false),
  });
  const now = useDisplayNow() ?? Date.now();
  const onRetried = () => setWatchUntil(Date.now() + RETRY_WATCH_MS);
  const data = status.data;
  const automatic = useAutomaticWork();
  return (
    <Stack gap="lg">
      <BackgroundWork
        sentence={
          data
            ? healthSentence(data, now)
            : status.isError
              ? "Couldn't read background status, so this page can't say whether anything is stuck."
              : "Checking…"
        }
        items={data?.stuck ?? []}
        onRetried={onRetried}
      />
      {/* Closed by default: the verdict needs no telemetry, and the read runs only once opened. */}
      <Disclosure summary="Queue details">
        <QueueDetailsBody now={now} />
      </Disclosure>
      {fromRetiredJobs ? (
        <p className="max-w-prose text-muted-foreground">
          The Jobs page is gone. Stuck and failed background work shows under
          Background work, and a Run's Jobs show on that Run.
        </p>
      ) : null}
      {status.isError && !data ? (
        <UnknownStatus
          error={status.error}
          onRetry={() => void status.refetch()}
        />
      ) : null}
      {automatic.stoppedAt ? (
        <AutomaticWorkStopped
          stoppedAt={automatic.stoppedAt}
          now={now}
          resume={automatic.resume}
        />
      ) : null}
      <NeedsYouQueue />
      <nav
        aria-label="More work"
        className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-border pt-2 [&>a]:text-link [&>a]:hover:underline [&>a]:max-md:inline-flex [&>a]:max-md:min-h-11 [&>a]:max-md:items-center"
      >
        <AgentBacklogLink />
        <Link to="/suggestions">Suggestions</Link>
        <Link to="/suggestions" search={{ status: "automatic" }}>
          Changes by Cubby
        </Link>
        <Link to="/work-queue" search={{ family: "research" }}>
          Missing facts
        </Link>
        <Link to="/work-queue">All work</Link>
        <Link to="/history">History</Link>
        {automatic.stoppedAt === null ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={automatic.stop.isPending}
            onClick={() => automatic.stop.mutate({})}
          >
            {automatic.stop.isPending ? "Stopping…" : "Stop automatic AI work"}
          </Button>
        ) : null}
      </nav>
    </Stack>
  );
}

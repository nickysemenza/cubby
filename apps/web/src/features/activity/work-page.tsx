import { NEEDS_YOU_FILTERS } from "@cubby/schemas/work-queue";
import type { WorkStatus, WorkStuckItem } from "@cubby/schemas/work-status";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { RetryJobsButton } from "~/features/job/retry-jobs";
import { hasIncompleteWorkInputs } from "~/features/work-queue/work-input-status";
import {
  WorkQueue,
  type WorkQueueMeta,
} from "~/features/work-queue/work-queue-page";
import { ai } from "~/integrations/tanstack-query/generated/domains/ai.gen";
import { workQueue } from "~/integrations/tanstack-query/generated/domains/workQueue.gen";
import { copyTextWithToast } from "~/lib/clipboard";
import { formatRelative } from "~/lib/date-format";
import { formatCount } from "~/lib/number-format";
import { showErrorToast } from "~/ui/feedback/error-details";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
import { Section, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";
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

function StuckSection({
  items,
  onRetried,
}: {
  items: readonly WorkStuckItem[];
  onRetried: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Section
      headingAs="h2"
      title="Stuck"
      count={formatCount(items.length)}
      ruled
    >
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
 * appears without a reload, and it settles the sidebar's count: both read the
 * same population, so they can never disagree on this page.
 */
function NeedsYouQueue({
  status,
}: {
  status: { count: number; complete: boolean } | undefined;
}) {
  const queryClient = useQueryClient();
  const [total, setTotal] = useState<number>();
  const [incomplete, setIncomplete] = useState(false);
  const statusKey = workQueue.status.queryKey(STATUS_INPUT);
  const onMeta = (meta: WorkQueueMeta) => {
    setTotal(meta.totalCount);
    setIncomplete(hasIncompleteWorkInputs(meta));
  };
  useEffect(() => {
    if (total === undefined || status?.count === total) return;
    queryClient.setQueryData<WorkStatus>(statusKey, (current) =>
      current
        ? {
            ...current,
            needsYou: { count: total, complete: !incomplete },
          }
        : current,
    );
  }, [total, incomplete, status?.count, queryClient, statusKey]);
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
        Automatic AI work stopped {formatRelative(stoppedAt, now)}. Refresh and
        connection discovery wait until you resume.
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

/** One verdict and one queue. Diagnostics live in MCP. */
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
      <p className="min-h-5.5 text-muted-foreground" data-testid="work-health">
        {data
          ? healthSentence(data, now)
          : status.isError
            ? "Couldn't read background status, so this page can't say whether anything is stuck."
            : "Checking…"}
      </p>
      {fromRetiredJobs ? (
        <p className="max-w-prose text-muted-foreground">
          The Jobs page is gone. Stuck background work shows here, and a Run's
          Jobs show on that Run.
        </p>
      ) : null}
      {status.isError && !data ? (
        <UnknownStatus
          error={status.error}
          onRetry={() => void status.refetch()}
        />
      ) : null}
      {data?.stuck.length ? (
        <StuckSection items={data.stuck} onRetried={onRetried} />
      ) : null}
      {automatic.stoppedAt ? (
        <AutomaticWorkStopped
          stoppedAt={automatic.stoppedAt}
          now={now}
          resume={automatic.resume}
        />
      ) : null}
      <NeedsYouQueue status={data?.needsYou} />
      <nav
        aria-label="More work"
        className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-border pt-2 [&>a]:text-link [&>a]:hover:underline [&>a]:max-md:inline-flex [&>a]:max-md:min-h-11 [&>a]:max-md:items-center"
      >
        <Link to="/suggestions">Suggestions</Link>
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

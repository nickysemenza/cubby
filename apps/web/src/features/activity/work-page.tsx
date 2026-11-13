import { MACHINERY_UNKNOWN_CALL_NOTE } from "@cubby/schemas/field-envelope-presentation";
import { AGENT_BACKLOG_INPUT } from "@cubby/schemas/work-queue";
import type { WorkStatus, WorkStuckItem } from "@cubby/schemas/work-status";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { NeedsYou } from "~/entity/machinery/needs-you";
import { ai } from "~/integrations/tanstack-query/generated/domains/ai.gen";
import { workQueue } from "~/integrations/tanstack-query/generated/domains/workQueue.gen";
import { copyTextWithToast } from "~/lib/clipboard";
import { formatRelative } from "~/lib/date-format";
import { formatCount } from "~/lib/number-format";
import { showErrorToast } from "~/ui/feedback/error-details";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
import { Section, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "~/ui/primitives/table";

/** Past this the list only counts the rest; a page of warnings stops being read. */
const STUCK_ROW_CAP = 8;
const STATUS_INPUT = {};

/** "2 background processes are stuck." and its peers: the page's always-on verdict. */
function healthSentence(status: WorkStatus, now: number) {
  const stuck = status.stuckCount;
  if (stuck)
    return stuck === 1
      ? "1 background process is stuck."
      : `${formatCount(stuck)} background processes are stuck.`;
  if (status.behind)
    return "Catching up. Some totals and search results may lag behind for a while. Nothing to do.";
  if (!status.lastFinishedAt) return "No records report stuck kernel work.";
  const finished = formatRelative(status.lastFinishedAt, now);
  return `No records report stuck kernel work. Last finished ${finished === "now" ? "just now" : finished}.`;
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

function StuckAction({ action }: { action: WorkStuckItem["action"] }) {
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
function StuckRow({ item }: { item: WorkStuckItem }) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-b border-border/60 py-2 md:grid-cols-[auto_minmax(0,1fr)_auto]">
      <WarningIcon
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-warning-ink"
      />
      <p className="font-medium text-foreground-strong">{item.title}</p>
      <div className="col-start-2 max-md:row-start-3 md:col-start-3 md:row-span-2 md:row-start-1">
        <StuckAction action={item.action} />
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
 * record link, under the page's health verdict. Stuck kernel scopes and
 * Runs read from `workQueue.status`.
 */
function BackgroundWork({
  sentence,
  items,
}: {
  sentence: string;
  items: readonly WorkStuckItem[];
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Section
      headingAs="h2"
      title="Kernel work"
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
          <StuckRow key={item.key} item={item} />
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

/** Kernel health and member gaps, with separate links to research and history. */
export function WorkPage({ fromRetiredJobs }: { fromRetiredJobs: boolean }) {
  const status = useQuery({
    ...workQueue.status.queryOptions(STATUS_INPUT),
    refetchInterval: false,
  });
  const now = useDisplayNow() ?? Date.now();
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
      />
      {fromRetiredJobs ? (
        <p className="max-w-prose text-muted-foreground">
          Open a record's machinery to inspect its scopes, Asks and Passes.
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
      <KernelDiagnostics />
      <NeedsYou />
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

/** Counts and failures come from durable kernel rows rather than record-gap sampling. */
function KernelDiagnostics() {
  const read = useQuery(workQueue.diagnostics.queryOptions({}));
  const retry = useMutation(
    workQueue.retry.mutationOptions({ onSuccess: () => void read.refetch() }),
  );
  return (
    <Section headingAs="h2" title="Queue and evaluations">
      {read.isError ? <p role="alert">{read.error.message}</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            {[
              "Work",
              "Kind",
              "Due",
              "Claimed",
              "Waiting",
              "Stuck",
              "Oldest waiting",
            ].map((label) => (
              <TableHead key={label}>{label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {read.data?.groups.map((group) => (
            <TableRow key={`${group.type}:${group.kind}`}>
              <TableCell>{group.type}</TableCell>
              <TableCell>{group.kind}</TableCell>
              <TableCell>{group.due}</TableCell>
              <TableCell>{group.claimed}</TableCell>
              <TableCell>{group.waiting}</TableCell>
              <TableCell>{group.stuck}</TableCell>
              <TableCell>{group.oldestWaiting ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {read.data?.failures.map((failure) => (
        <div
          key={JSON.stringify(failure.target)}
          className="grid gap-1 border-b border-border py-2"
        >
          <span className="text-xs">{failure.label}</span>
          <pre className="text-xs break-words whitespace-pre-wrap">
            {failure.error}
          </pre>
          {failure.unknown ? <p>{MACHINERY_UNKNOWN_CALL_NOTE}</p> : null}
          <Button
            size="xs"
            variant="outline"
            className="justify-self-start"
            disabled={retry.isPending}
            onClick={() => retry.mutate(failure.target)}
          >
            {failure.unknown ? "It was not sent: ask again" : "Retry"}
          </Button>
        </div>
      ))}
      {retry.error ? <p role="alert">{retry.error.message}</p> : null}
    </Section>
  );
}

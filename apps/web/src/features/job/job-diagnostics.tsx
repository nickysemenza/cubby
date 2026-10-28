import { jobState } from "@cubby/schemas/job";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId, useMemo, useState } from "react";

import {
  JOB_LOG_LEVELS,
  type JobFacts,
  type JobGroup,
  type JobListOut,
  type JobLogsOut,
} from "~/contracts/job.contract";
import { job } from "~/integrations/tanstack-query/domains/job";
import { formatInstant } from "~/lib/date-format";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { Picker } from "~/ui/combobox/picker";
import { type Fact, Facts } from "~/ui/common/facts";
import { RecordList, type RecordListState } from "~/ui/common/record-list";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { CloudflareIcon } from "~/ui/icons/cloudflare";
import { Disclosure } from "~/ui/layout/disclosure";
import { Panel } from "~/ui/layout/panel";
import { Section } from "~/ui/layout/section";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { StaticTable } from "~/ui/primitives/static-table";

import { jobWait } from "../run/run-view-model";
import { JobDefinition } from "../run/work-definition";
import { JOB_STATE_LABEL, JobStatePill, WaitNotice } from "./job-status";

const time = (iso: string | null) =>
  iso ? formatInstant(iso, "dateShortTime") : "—";
const shortId = (id: string) => id.slice(0, 8);

/** One Job's execution facts: identity, state, wait, attempts, generation. */
function JobFactsList({ facts }: { facts: JobFacts }) {
  const items: Fact[] = [
    {
      id: "job",
      label: "Job",
      value: (
        <span className="font-mono">
          {shortId(facts.id)} · {facts.kind}
        </span>
      ),
    },
    {
      id: "state",
      label: "State",
      value: <JobStatePill state={facts.state} />,
    },
    {
      id: "attempt",
      label: "Attempt",
      value: `${formatCount(facts.attempts)} of ${facts.maxAttempts === null ? "unbounded" : formatCount(facts.maxAttempts)}`,
    },
    {
      id: "wait",
      label: "Wait reason",
      value: facts.waitReason ? (
        <span className="font-mono">{facts.waitReason}</span>
      ) : (
        "—"
      ),
    },
    {
      id: "generation",
      label: "Generation",
      value: formatCount(facts.generation),
    },
    { id: "available", label: "Available at", value: time(facts.availableAt) },
    ...(facts.waitUntil
      ? [{ id: "until", label: "Waits until", value: time(facts.waitUntil) }]
      : []),
    ...(facts.leaseExpiresAt
      ? [
          {
            id: "lease",
            label: "Lease expires",
            value: time(facts.leaseExpiresAt),
          },
        ]
      : []),
    {
      id: "key",
      label: "Key",
      value: <span className="font-mono">{facts.key}</span>,
    },
    { id: "updated", label: "Updated", value: time(facts.updatedAt) },
  ];
  return (
    <div className="grid gap-2">
      <Facts layout="list" facts={items} />
      {facts.error ? (
        <pre className="max-h-[30vh] overflow-auto rounded-lg bg-destructive-surface px-2.5 py-2 font-mono text-xs/4.25 break-words whitespace-pre-wrap text-destructive">
          {facts.error}
        </pre>
      ) : null}
    </div>
  );
}

const stateSummary = (group: JobGroup) =>
  Object.entries(group.states)
    .map(
      ([state, count]) =>
        `${formatCount(count)} ${JOB_STATE_LABEL[jobState.parse(state)]}`,
    )
    .join(" · ");

/** Fan-out Jobs by kind: counts per state, wait reasons and the latest one. */
function JobsTable({ groups }: { groups: readonly JobGroup[] }) {
  if (groups.length === 0)
    return <p className="text-xs text-muted-foreground">No other Jobs.</p>;
  return (
    <StaticTable
      rows={groups}
      rowKey={(group) => group.kind}
      containerClassName="max-md:overflow-x-auto"
      className="min-w-[45rem]"
      columns={[
        {
          id: "kind",
          header: "Kind",
          cell: (group) => <span className="font-mono">{group.kind}</span>,
        },
        {
          id: "count",
          header: "Jobs",
          cell: (group) => formatCount(group.count),
          cellClassName: "tabular-nums",
        },
        { id: "states", header: "States", cell: stateSummary },
        {
          id: "waits",
          header: "Waiting on",
          cell: (group) =>
            Object.entries(group.waitReasons)
              .map(([reason, count]) => `${formatCount(count)} ${reason}`)
              .join(" · ") || "—",
        },
        {
          id: "latest",
          header: "Latest",
          cell: (group) => (
            <span className="font-mono">
              {shortId(group.latest.id)} · {time(group.latest.updatedAt)}
            </span>
          ),
        },
      ]}
    />
  );
}

type Level = (typeof JOB_LOG_LEVELS)[number] | "all";
const isLevel = (value: string | null): value is Level =>
  value === "all" || JOB_LOG_LEVELS.some((level) => level === value);

function LogState({
  title,
  children,
  logs,
}: {
  title: string;
  children: React.ReactNode;
  logs: JobLogsOut;
}) {
  return (
    <div className="grid justify-items-start gap-1.5 bg-muted p-5 text-sm text-muted-foreground">
      <strong className="text-foreground-strong">{title}</strong>
      {children}
      <a
        href={logs.dashboardUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-xs text-link hover:underline"
      >
        Open Workers Observability{" "}
        <ArrowSquareOutIcon aria-hidden className="size-3" />
      </a>
    </div>
  );
}

/**
 * One Job's raw Worker log lines over its active window, read through the
 * Workers Observability query API: a level filter, search and the dashboard
 * link. Missing credentials, expired retention and query failures are states.
 */
export function JobLogPanel({ jobId }: { jobId: string }) {
  const logs = useQuery({ ...job.logs.queryOptions({ jobId }) });
  const [level, setLevel] = useState<Level>("all");
  const [search, setSearch] = useState("");
  const searchId = useId();
  const query = useDeferredValue(search.trim().toLowerCase());
  const data = logs.data;
  const lines = useMemo(
    () => (data?.status === "ok" ? data.lines : []),
    [data],
  );
  const counts = useMemo(() => {
    const byLevel = new Map<string, number>();
    for (const line of lines)
      byLevel.set(line.level, (byLevel.get(line.level) ?? 0) + 1);
    return byLevel;
  }, [lines]);
  const shown = lines.filter(
    (line) =>
      (level === "all" || line.level === level) &&
      (!query ||
        line.message.toLowerCase().includes(query) ||
        line.fields?.toLowerCase().includes(query)),
  );
  return (
    <Panel
      tone="default"
      flush
      className="mt-1.5 overflow-hidden"
      data-testid="job-logs"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
        <Picker
          mode="segmented"
          label="Log level"
          value={level}
          options={[
            { value: "all", label: "All", hint: formatCount(lines.length) },
            ...JOB_LOG_LEVELS.map((value) => ({
              value,
              label: value,
              hint: formatCount(counts.get(value) ?? 0),
            })),
          ]}
          onValueChange={(value) => {
            if (isLevel(value)) setLevel(value);
          }}
        />
        <label htmlFor={searchId} className="sr-only">
          Search log lines
        </label>
        <div className="relative flex items-center">
          <MagnifyingGlassIcon
            aria-hidden
            className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
          />
          <Input
            id={searchId}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search lines"
            className="h-7 w-52 pl-7 text-xs max-md:h-11 max-md:w-full"
          />
        </div>
        <span className="flex-1" />
        <a
          href={data?.dashboardUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-link hover:underline"
        >
          <span aria-hidden className="flex size-3.5 [&_svg]:size-3.5">
            <CloudflareIcon />
          </span>
          Cloudflare dashboard
          <ArrowSquareOutIcon aria-hidden className="size-3" />
        </a>
      </div>
      {logs.isPending ? (
        <RecordList state={{ status: "pending", rows: 4 }} />
      ) : logs.isError ? (
        <div className="p-3">
          <ErrorDisplay
            error={logs.error}
            title="Couldn't read logs"
            onRetry={() => void logs.refetch()}
          />
        </div>
      ) : data?.status === "not_configured" ? (
        <LogState logs={data} title="Inline logs aren't configured">
          <span>
            Set the <code className="font-mono">AI_GATEWAY_API_KEY</code>{" "}
            secret, with the account's Workers Observability Edit permission, to
            read this Job's lines here.
          </span>
        </LogState>
      ) : data?.status === "expired" ? (
        <LogState logs={data} title="Raw logs expired">
          <span>
            Workers Logs keeps raw lines for 7 days; this Job ran{" "}
            {formatInstant(data.window.from, "dateShortTime")} –{" "}
            {formatInstant(data.window.to, "dateShortTime")}. The step's stored
            counts and failures above remain.
          </span>
        </LogState>
      ) : data?.status === "error" ? (
        <div className="grid gap-2 bg-destructive-surface p-3 text-destructive">
          <p className="text-sm font-semibold">Couldn't read logs</p>
          <pre className="max-h-[30vh] overflow-auto rounded-lg bg-background/60 px-2.5 py-2 font-mono text-xs/4.25 break-words whitespace-pre-wrap text-foreground">
            {data.request}
            {"\n"}
            {data.message}
          </pre>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit max-md:min-h-11"
            onClick={() => void logs.refetch()}
          >
            <ArrowClockwiseIcon aria-hidden /> Retry
          </Button>
        </div>
      ) : data?.status === "ok" ? (
        <>
          <div className="max-h-85 overflow-auto bg-muted py-1 font-mono text-xs/4.5">
            {shown.length === 0 ? (
              <p className="px-2.5 py-2 text-muted-foreground">
                {lines.length === 0
                  ? "No lines in this Job's window."
                  : "No lines match."}
              </p>
            ) : (
              shown.map((line) => (
                <div
                  key={line.id}
                  className="grid grid-cols-[5.75rem_2.75rem_minmax(0,1fr)] gap-2.5 px-2.5 py-px hover:bg-foreground/5 max-md:grid-cols-[5.25rem_2.5rem_minmax(0,1fr)] max-md:gap-1.5 max-md:text-2xs"
                >
                  <span className="text-muted-foreground">
                    {formatInstant(line.timestamp, "time")}
                  </span>
                  <span
                    className={cn(
                      "font-semibold",
                      line.level === "debug" && "text-muted-foreground",
                      line.level === "info" && "text-info",
                      line.level === "warn" && "text-warning",
                      line.level === "error" && "text-destructive",
                    )}
                  >
                    {line.level}
                  </span>
                  <span className="break-words whitespace-pre-wrap text-foreground">
                    {line.message}
                    {line.fields ? (
                      <span className="text-muted-foreground">
                        {" "}
                        {line.fields}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))
            )}
          </div>
          <p className="flex flex-wrap justify-between gap-2 border-t border-border px-2.5 py-1.5 text-2xs text-muted-foreground">
            <span>
              {formatCount(shown.length)} of {formatCount(data.count)} lines ·{" "}
              jobId={shortId(jobId)} · {formatInstant(data.window.from, "time")}{" "}
              – {formatInstant(data.window.to, "time")}
            </span>
            <span>Credentials scrubbed; nothing else is masked</span>
          </p>
        </>
      ) : null}
    </Panel>
  );
}

/** Diagnostics for a Run: its executing Job, fan-out Jobs and raw logs. */
export function JobDiagnostics({
  jobs,
  state,
}: {
  jobs: JobListOut | undefined;
  state: RecordListState;
}) {
  if (state.status !== "success" || !jobs)
    return (
      <RecordList
        state={state.status === "success" ? { status: "pending" } : state}
      />
    );
  return (
    <div className="grid gap-5">
      {jobs.primary ? (
        <div className="grid gap-3">
          <JobDefinition kind={jobs.primary.kind} />
          <JobFactsList facts={jobs.primary} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No Job executes this Run.
        </p>
      )}
      <Section headingAs="h3" compact title="Jobs" count={jobs.groups.length}>
        <JobsTable groups={jobs.groups} />
      </Section>
      {jobs.primary ? (
        <Section
          headingAs="h3"
          compact
          title="Logs"
          caption="Raw Worker lines for this Job's active window."
        >
          <JobLogPanel jobId={jobs.primary.id} />
        </Section>
      ) : null}
    </div>
  );
}

/**
 * A record's own single-item Jobs (an Image's processing, a Location's AI)
 * behind a closed disclosure, so nothing (logs included) is read until opened.
 */
export function SubjectJobsDisclosure({
  subject,
}: {
  subject: { kind: "image" | "location"; id: string };
}) {
  return (
    <Disclosure summary="Jobs" className="text-xs">
      <SubjectJobs subject={subject} />
    </Disclosure>
  );
}

/** The same status, wait and log pieces a Run's diagnostics use. */
function SubjectJobs({
  subject,
}: {
  subject: { kind: "image" | "location"; id: string };
}) {
  const jobs = useQuery({ ...job.list.queryOptions({ subject }) });
  if (jobs.isPending)
    return <RecordList state={{ status: "pending", rows: 2 }} />;
  if (jobs.isError)
    return (
      <ErrorDisplay
        error={jobs.error}
        title="Couldn't load Jobs"
        onRetry={() => void jobs.refetch()}
      />
    );
  const primary = jobs.data.primary;
  if (!primary)
    return (
      <p className="text-xs text-muted-foreground">No Jobs for this record.</p>
    );
  const wait = jobWait(primary);
  return (
    <div className="grid gap-3">
      {wait ? <WaitNotice wait={wait} /> : null}
      <JobFactsList facts={primary} />
      {jobs.data.groups.length ? <JobsTable groups={jobs.data.groups} /> : null}
      <JobLogPanel jobId={primary.id} />
    </div>
  );
}

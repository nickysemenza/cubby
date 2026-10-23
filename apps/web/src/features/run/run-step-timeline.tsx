import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";
import { type ReactNode, useState } from "react";

import { formatInstant } from "~/lib/date-format";
import { formatDuration } from "~/lib/format-duration";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { InspectableValue } from "~/ui/common/inspectable-value";
import { type KeyNumber, KeyNumbers } from "~/ui/common/key-numbers";
import {
  RecordDot,
  type RecordDotState,
  RecordList,
  RecordRow,
} from "~/ui/common/record-list";
import { Disclosure } from "~/ui/layout/disclosure";
import { Progress } from "~/ui/primitives/progress";

import { WaitNotice } from "../job/job-status";
import {
  humanizeKey,
  INPUT_MODE_LABEL,
  type RunStepView,
  STEP_PHASE_LABEL,
  type StepPhase,
} from "./run-view-model";

const DOT_STATE = {
  done: "done",
  running: "running",
  waiting: "waiting",
  paused: "waiting",
  failed: "failed",
  not_started: "not_reached",
} as const satisfies Record<StepPhase, RecordDotState>;

const clock = (iso: string) => formatInstant(iso, "clock");

/** One funnel row: a reason or outcome with its count and share of the step. */
type BreakdownRow = {
  id: string;
  label: string;
  count: number;
  depth: 0 | 1 | 2;
  /** Mono reason code, or the drill into the ledger. */
  code?: string;
  candidate?: boolean;
  onShow?: () => void;
};

export type BreakdownGroup = {
  id: string;
  title: string;
  note: string;
  rows: BreakdownRow[];
};

/**
 * "Where the inputs went": upstream reason counts stored on the step, then
 * per-candidate outcomes from its published Assessments. Shares are of the
 * group's first row.
 */
export function ReasonBreakdown({
  unit,
  processed,
  groups,
}: {
  unit: string;
  processed: number;
  groups: readonly BreakdownGroup[];
}) {
  const visible = groups.filter((group) => group.rows.length > 0);
  if (visible.length === 0) return null;
  return (
    <Disclosure
      defaultOpen
      summary={`Where the ${unit} went`}
      meta={`${formatCount(processed)} ${unit}`}
      className="text-xs"
    >
      <div className="mt-1.5 grid" data-testid="reason-breakdown">
        {visible.map((group) => {
          const base = Math.max(1, group.rows[0]?.count ?? 1);
          return (
            <div key={group.id} className="grid">
              <p className="flex flex-wrap items-baseline gap-2 pt-2 pb-0.5 text-2xs text-muted-foreground">
                <b className="text-xs font-semibold text-foreground">
                  {group.title}
                </b>
                {group.note}
              </p>
              {group.rows.map((row) => (
                <div
                  key={row.id}
                  className="grid min-h-6.5 grid-cols-[minmax(0,1fr)_4.5rem_10rem_7.25rem] items-center gap-3 border-t border-border/60 text-xs max-md:grid-cols-[minmax(0,1fr)_3.75rem_4rem] max-md:gap-2"
                >
                  <span
                    className={cn(
                      "truncate",
                      row.depth === 0 && "font-semibold text-foreground-strong",
                      row.depth === 1 && "pl-4",
                      row.depth === 2 && "pl-8",
                    )}
                  >
                    {row.code ? (
                      <InspectableValue value={row.code}>
                        {row.label}
                      </InspectableValue>
                    ) : (
                      row.label
                    )}
                  </span>
                  <span className="text-right font-mono tabular-nums">
                    {formatCount(row.count)}
                  </span>
                  <span
                    aria-hidden
                    className="relative h-1.5 bg-muted max-md:hidden"
                  >
                    <span
                      className={cn(
                        "absolute inset-y-0 left-0 min-w-px",
                        row.candidate ? "bg-info" : "bg-foreground/40",
                      )}
                      style={{
                        width: `${Math.min(100, (row.count / base) * 100)}%`,
                      }}
                    />
                  </span>
                  <span className="min-w-0 truncate text-right">
                    {row.onShow ? (
                      <button
                        type="button"
                        className="text-link hover:underline max-md:min-h-11"
                        onClick={row.onShow}
                      >
                        Show ↓
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </Disclosure>
  );
}

function InputBlock({ step }: { step: RunStepView }) {
  if (step.mode !== "count" || step.total === null) {
    return (
      <p className="flex flex-wrap items-baseline gap-x-3 text-xs">
        <span className="font-mono text-sm font-semibold text-foreground-strong">
          {formatCount(step.processed)}
        </span>
        <span className="text-muted-foreground">
          {step.unit} so far
          {step.mode === "estimate" && step.total !== null
            ? ` · about ${formatCount(step.total)} provider estimate`
            : ""}
        </span>
      </p>
    );
  }
  const completed = step.total - (step.left ?? 0);
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span>
          <span className="font-mono text-sm font-semibold text-foreground-strong">
            {formatCount(completed)}
          </span>{" "}
          of{" "}
          <span className="font-mono text-sm font-semibold text-foreground-strong">
            {formatCount(step.total)}
          </span>{" "}
          {step.unit}
        </span>
        <span className="ml-auto flex flex-wrap gap-3 text-muted-foreground max-md:ml-0 max-md:w-full">
          {step.fraction !== null ? (
            <span className="font-mono tabular-nums">
              {Math.floor(step.fraction * 100)}%
            </span>
          ) : null}
          {step.rate ? (
            <>
              <span>Step ETA: {step.rate.estimate}</span>
              <span>
                {formatCount(Math.round(step.rate.perMinute))} {step.unit}/min{" "}
                {step.rate.basis}
              </span>
            </>
          ) : step.ratePaused ? (
            <span>Rate paused</span>
          ) : step.phase === "running" ? (
            <span>Step ETA: Unknown — collecting progress intervals</span>
          ) : null}
        </span>
      </div>
      <Progress
        value={completed}
        max={step.total}
        paused={step.phase !== "running"}
        aria-label={`${step.label} progress`}
      />
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <LockSimpleIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
        <span>
          Frozen at step start
          {step.countedAt ? ` (${clock(step.countedAt)})` : ""}:{" "}
          {formatCount(step.total)} {step.unit}
          {step.boundary ? ` within ${step.boundary}` : ""}. Later arrivals go
          to the next pass.
          {(step.tallies.find((tally) => tally.key === "removed")?.value ?? 0) >
          0
            ? ` ${formatCount(step.tallies.find((tally) => tally.key === "removed")?.value ?? 0)} left eligibility mid-step and count as removed.`
            : ""}
        </span>
      </p>
    </div>
  );
}

/** Where the last page's time went, per phase, with its query count. */
function PageWork({ page }: { page: RunStepView["page"] }) {
  if (!page)
    return (
      <p className="text-xs text-muted-foreground" data-testid="page-work">
        Page time breakdown: not measured
      </p>
    );
  return (
    <div className="grid gap-1" data-testid="page-work">
      <p className="flex flex-wrap items-baseline gap-x-3 text-xs">
        <span className="font-medium text-foreground">Last page</span>
        <span className="font-mono text-muted-foreground tabular-nums">
          {formatDuration(page.totalMs)}
        </span>
        <span className="text-muted-foreground">
          {page.queries === null
            ? "queries not measured"
            : `${formatCount(page.queries)} queries/page`}
        </span>
      </p>
      {page.phases.map((phase) => (
        <div
          key={phase.phase}
          className="grid grid-cols-[minmax(0,8rem)_4.5rem_minmax(0,10rem)_auto] items-center gap-3 text-xs max-md:grid-cols-[minmax(0,1fr)_4rem_4rem]"
        >
          <span className="truncate">{humanizeKey(phase.phase)}</span>
          <span className="text-right font-mono tabular-nums">
            {formatDuration(phase.ms)}
          </span>
          <span aria-hidden className="relative h-1.5 bg-muted">
            <span
              className="absolute inset-y-0 left-0 min-w-px bg-foreground/40"
              style={{ width: `${Math.min(100, phase.share * 100)}%` }}
            />
          </span>
          <span className="font-mono text-muted-foreground tabular-nums max-md:hidden">
            {Math.round(phase.share * 100)}%
            {page.concurrency[phase.phase] !== undefined
              ? ` · ${formatCount(page.concurrency[phase.phase] ?? 0)} in flight`
              : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The current step's facts beneath its title: action, input, tallies, wait, failures. */
function StepBody({
  step,
  speed,
  breakdown,
  links,
}: {
  step: RunStepView;
  speed: string | null;
  breakdown?: ReactNode;
  links?: ReactNode;
}) {
  const tallies: KeyNumber[] = step.tallies.map((tally) => ({
    id: tally.key,
    label: tally.label,
    value: formatCount(tally.value),
  }));
  return (
    <div className="mt-2.5 grid max-w-[53.75rem] gap-3">
      {step.action ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-muted-foreground">Now</span>
          {step.action}
        </p>
      ) : null}
      <InputBlock step={step} />
      {speed && (step.phase === "running" || step.phase === "waiting") ? (
        <p className="text-xs text-foreground" data-testid="speed-set-by">
          {speed}
        </p>
      ) : null}
      {step.phase !== "not_started" ? <PageWork page={step.page} /> : null}
      {step.wait ? <WaitNotice wait={step.wait} /> : null}
      {step.errors.length ? (
        <div className="grid gap-1.5">
          <p className="text-xs font-medium text-destructive">
            {formatCount(step.failed)} failed
            {step.errors.length < step.failed
              ? ` · latest ${step.errors.length} shown`
              : ""}
          </p>
          <pre className="max-h-[30vh] overflow-auto rounded-lg bg-destructive-surface px-2.5 py-2 font-mono text-xs/4.25 break-words whitespace-pre-wrap text-destructive">
            {step.errors
              .map(
                (error) =>
                  `${clock(error.at)}${error.ref ? ` ${error.ref}` : ""}  ${error.message}`,
              )
              .join("\n")}
          </pre>
        </div>
      ) : null}
      <KeyNumbers
        layout="tallies"
        label={`${step.label} tallies`}
        items={tallies}
      />
      {breakdown}
      {links ? (
        <div className="flex flex-wrap gap-3.5 text-xs">{links}</div>
      ) : null}
    </div>
  );
}

function StepSummary({ step }: { step: RunStepView }) {
  if (step.phase === "not_started")
    return (
      <p className="mt-1 text-xs text-foreground">
        {step.mode === "tally"
          ? "Counts as it goes."
          : "Counts its inputs when it starts."}
      </p>
    );
  const figures = [
    step.mode === "count" && step.total !== null
      ? `${formatCount(step.total - (step.left ?? 0))} of ${formatCount(step.total)} ${step.unit}`
      : `${formatCount(step.processed)} ${step.unit}`,
    ...step.tallies.map(
      (tally) => `${formatCount(tally.value)} ${tally.label.toLowerCase()}`,
    ),
  ];
  return (
    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-foreground">
      {figures.map((figure) => (
        <span key={figure}>{figure}</span>
      ))}
    </p>
  );
}

/**
 * The Run's steps in order on the shared timeline rail. Each card says what
 * the step is for, its input mode and state; the step that is moving opens
 * with its count, rate, wait and reason breakdown.
 */
export function RunStepTimeline({
  steps,
  speed,
  breakdownOf,
  linksOf,
}: {
  steps: readonly RunStepView[];
  /** "Speed set by" for the moving step. */
  speed: string | null;
  breakdownOf?: (step: RunStepView) => ReactNode;
  linksOf?: (step: RunStepView) => ReactNode;
}) {
  const initial = steps.find((step) =>
    ["running", "waiting", "paused", "failed"].includes(step.phase),
  )?.key;
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(initial ? [initial] : []),
  );
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <RecordList variant="timeline" aria-label="Steps">
      {steps.map((step) => {
        const expanded = open.has(step.key);
        const started = step.phase !== "not_started";
        return (
          <RecordRow
            key={step.key}
            data-testid={`run-step-${step.key}`}
            leading={
              <RecordDot
                state={DOT_STATE[step.phase]}
                label={STEP_PHASE_LABEL[step.phase]}
                spoken={false}
              />
            }
            primary={
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                {started ? (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggle(step.key)}
                    className="inline-flex min-w-0 items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
                  >
                    <CaretRightIcon
                      aria-hidden
                      className={cn(
                        "size-3.5 text-muted-foreground transition-transform duration-150",
                        expanded && "rotate-90",
                      )}
                    />
                    <h3 className="text-sm font-semibold text-foreground-strong">
                      {step.label}
                    </h3>
                  </button>
                ) : (
                  <h3 className="text-sm font-medium text-muted-foreground">
                    {step.label}
                  </h3>
                )}
                <span
                  className={cn(
                    "text-xs text-muted-foreground",
                    step.phase === "running" && "font-medium text-info",
                    step.phase === "failed" && "font-medium text-destructive",
                  )}
                >
                  <InspectableValue value={step.phase}>
                    {STEP_PHASE_LABEL[step.phase]}
                  </InspectableValue>
                </span>
                <span className="inline-flex h-4.5 items-center rounded-md border border-border px-1.5 text-2xs text-muted-foreground">
                  <InspectableValue value={step.mode}>
                    {INPUT_MODE_LABEL[step.mode]}
                  </InspectableValue>
                </span>
              </span>
            }
            trailing={
              step.startedAt ? (
                <span className="font-mono">
                  {clock(step.startedAt)}
                  {step.durationMs !== null
                    ? ` · ${formatDuration(step.durationMs)}`
                    : ""}
                </span>
              ) : null
            }
            clip={false}
            stacked
            secondary={
              <>
                {step.purpose ? (
                  <span className="block max-w-[78ch]">{step.purpose}</span>
                ) : null}
                {expanded ? null : <StepSummary step={step} />}
              </>
            }
            detail={
              expanded ? (
                <StepBody
                  step={step}
                  speed={speed}
                  breakdown={breakdownOf?.(step)}
                  links={linksOf?.(step)}
                />
              ) : null
            }
          />
        );
      })}
    </RecordList>
  );
}

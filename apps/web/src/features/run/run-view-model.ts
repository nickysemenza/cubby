import {
  assessmentFamily,
  type AssessmentFamily,
} from "@cubby/schemas/assessment";
import type { JobWaitReason } from "@cubby/schemas/job";
import {
  runStepDeclaration,
  type RunStepInputMode,
} from "@cubby/schemas/run-fields";
import {
  runStepMeta,
  type RunStepError,
  type RunStepMeta,
} from "@cubby/schemas/run-step";
import {
  runWorkEstimate,
  formatRunWorkEstimate,
} from "@cubby/schemas/run-work-progress";
import { z } from "zod";

import type {
  JobFacts,
  JobListOut,
  LimitBinding,
} from "~/contracts/job.contract";
import type {
  RunDecisionStatus,
  RunDetailStep,
  RunDetailStepsOut,
} from "~/contracts/run-detail.contract";
import { formatInstant } from "~/lib/date-format";
import { declaredRunSteps } from "~/lib/run-plan";

/**
 * The Run detail page's one reading of stored RunSteps and Job facts. Every
 * component renders these shapes; only `stepView` reads the stored step meta
 * and the step's manifest declaration.
 */

export type StepInputMode = RunStepInputMode;

const readMeta = (meta: RunDetailStep["meta"]): Partial<RunStepMeta> =>
  runStepMeta.partial().safeParse(meta ?? {}).data ?? {};

export type StepPhase =
  | "done"
  | "running"
  | "waiting"
  | "paused"
  | "failed"
  | "not_started";

export const STEP_PHASE_LABEL = {
  done: "Done",
  running: "Running",
  waiting: "Waiting",
  paused: "Paused",
  failed: "Failed",
  not_started: "Not started",
} as const satisfies Record<StepPhase, string>;

export const INPUT_MODE_LABEL = {
  count: "Counted input",
  estimate: "Provider estimate",
  tally: "Tally",
} as const satisfies Record<StepInputMode, string>;

const PHASE_OF = {
  queued: "not_started",
  running: "running",
  waiting: "waiting",
  paused: "paused",
  done: "done",
  failed: "failed",
} as const satisfies Record<RunDetailStep["state"], StepPhase>;

/** Why a step or Job is not moving, with the raw detail it was stored with. */
export type StepWait = {
  reason: JobWaitReason | "behind" | "retry" | "paused";
  label: string;
  /** "until 11:42", "attempt 2 of 3": the quiet line beside the pill. */
  until: string | null;
  /** The raw stored failure or pause reason, credentials scrubbed only. */
  raw: string | null;
};

type StepRate = {
  perMinute: number;
  /** Where the rate comes from ("over the last 10 min", "since it started"). */
  basis: string;
  estimate: string;
};

type StepTally = { key: string; label: string; value: number };

/** Where the last page's time went; null fields were not measured. */
type StepPageWork = {
  phases: { phase: string; ms: number; share: number }[];
  totalMs: number;
  queries: number | null;
  /** Peak in-flight work per bounded phase. */
  concurrency: Record<string, number>;
};

export type RunStepView = {
  key: string;
  position: number;
  label: string;
  purpose: string | null;
  unit: string;
  mode: StepInputMode;
  phase: StepPhase;
  /** What it is doing now; only while running or waiting. */
  action: string | null;
  /** Count and estimate modes: the frozen total or the provider's estimate. */
  total: number | null;
  processed: number;
  /** `found − done − failed − skipped − removed`; count mode only. */
  left: number | null;
  /** 0–1 of the frozen count; count mode only. */
  fraction: number | null;
  countedAt: string | null;
  boundary: string | null;
  /** Running count mode only; waiting and paused steps say "Rate paused". */
  rate: StepRate | null;
  ratePaused: boolean;
  tallies: StepTally[];
  reasons: { code: string; count: number }[];
  wait: StepWait | null;
  /** Null when the step's driver does not measure its pages yet. */
  page: StepPageWork | null;
  errors: RunStepError[];
  failed: number;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  results: AssessmentFamily | null;
};

/** `no_candidate`, `image.process` and `publishFailed` read as words. */
export const humanizeKey = (key: string) => {
  const words = key
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll(/[_.-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** `image.process` Jobs read as "image Jobs" in wait copy. */
const jobKindNoun = (kind: string) => kind.split(".")[0] ?? kind;

const WAIT_LABEL = {
  provider_capacity: "AI capacity",
  ai_funding_window: "Funding window",
  rate_limit: "Provider rate limit",
  device: "Waiting for a device",
} as const satisfies Record<JobWaitReason, string>;

const clock = (iso: string) => formatInstant(iso, "clock");

/** Why the Run's Job is not executing now, when it is waiting at all. */
export function jobWait(job: JobFacts | null): StepWait | null {
  if (!job) return null;
  if (job.waitReason)
    return {
      reason: job.waitReason,
      label: WAIT_LABEL[job.waitReason],
      until: job.waitUntil ? `until ${clock(job.waitUntil)}` : null,
      raw: job.error,
    };
  if (job.state === "retry_wait")
    return {
      reason: "retry",
      label: "Retrying",
      until: `attempt ${job.attempts + 1} of ${job.maxAttempts} at ${clock(job.availableAt)}`,
      raw: job.error,
    };
  if (job.state === "queued" && job.ahead)
    return {
      reason: "behind",
      label: `Waiting behind ${job.ahead.toLocaleString("en-US")} ${jobKindNoun(job.kind)} Jobs`,
      until: `${job.ahead.toLocaleString("en-US")} same-kind Jobs ahead`,
      raw: null,
    };
  return null;
}

const boundaryText = (boundary: unknown): string | null => {
  if (boundary === null || boundary === undefined) return null;
  if (typeof boundary !== "string") return JSON.stringify(boundary);
  // A cutoff instant reads as a date; other boundaries stay raw.
  return z.iso.datetime().safeParse(boundary).success
    ? formatInstant(boundary, "dateShortTime")
    : boundary;
};

function rateOf(
  step: RunDetailStep,
  meta: Partial<RunStepMeta>,
  now: number,
): StepRate | null {
  const sample = meta.work?.current;
  const estimate = sample ? runWorkEstimate(sample) : null;
  if (
    sample?.ratePerSecond &&
    estimate &&
    sample.phase === step.key &&
    !sample.finished &&
    now - Date.parse(sample.sampledAt) <= 120_000 &&
    sample.activity !== "capacity" &&
    sample.activity !== "retry"
  ) {
    const perSecond = sample.ratePerSecond;
    return {
      perMinute: perSecond * 60,
      basis: "across progress intervals, including queue delays",
      estimate: formatRunWorkEstimate(estimate),
    };
  }
  return null;
}

function stepCounts(
  mode: RunStepInputMode,
  step: RunDetailStep,
  meta: Partial<RunStepMeta>,
) {
  const removed = meta.tallies?.removed ?? 0;
  const processed = step.done + step.failed + step.skipped + removed;
  const total =
    mode === "count"
      ? (meta.input?.total ??
        (step.pages > 0 || step.startedAt ? step.found : null))
      : mode === "estimate"
        ? (meta.input?.total ?? null)
        : null;
  const left = mode === "count" ? step.left : null;
  return {
    processed,
    total,
    left,
    fraction:
      mode === "count" && total
        ? Math.min(1, (total - (left ?? 0)) / total)
        : null,
  };
}

function stepView(
  purpose: string,
  step: RunDetailStep,
  job: JobFacts | null,
  now: number,
): RunStepView {
  const meta = readMeta(step.meta);
  const declaration = runStepDeclaration(purpose, step.key);
  const phase = PHASE_OF[step.state];
  // The frozen input wins; a step that has not counted yet reads as declared.
  const mode = meta.input?.mode ?? declaration?.input.mode ?? "tally";
  const { processed, total, left, fraction } = stepCounts(mode, step, meta);
  const live = phase === "running" || phase === "waiting";
  const stepWait: StepWait | null =
    phase === "waiting" || phase === "paused"
      ? (jobWait(job) ?? {
          reason: "paused",
          label: phase === "paused" ? "Paused" : "Waiting",
          until: step.pausedUntil ? `until ${clock(step.pausedUntil)}` : null,
          raw: step.pausedReason,
        })
      : null;
  const started = step.startedAt ? Date.parse(step.startedAt) : null;
  const ended = step.endedAt ? Date.parse(step.endedAt) : null;
  return {
    key: step.key,
    position: step.position,
    label: declaration?.label ?? step.label,
    purpose: declaration?.purpose ?? null,
    unit: declaration?.unit ?? "items",
    mode,
    phase,
    action: live ? (meta.action ?? declaration?.action ?? null) : null,
    total,
    processed,
    left,
    fraction,
    countedAt: meta.input?.countedAt ?? step.startedAt,
    boundary: boundaryText(meta.input?.boundary),
    rate:
      mode === "count" &&
      phase === "running" &&
      !jobWait(job) &&
      (!job || job.state === "running")
        ? rateOf(step, meta, now)
        : null,
    ratePaused: mode === "count" && (phase === "waiting" || phase === "paused"),
    tallies: Object.entries(meta.tallies ?? {}).map(([key, value]) => ({
      key,
      label: humanizeKey(key),
      value,
    })),
    reasons: Object.entries(meta.reasons ?? {})
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
    wait: stepWait,
    page: pageWorkOf(meta),
    errors: step.errors,
    failed: step.failed,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
    durationMs:
      started === null ? null : (ended ?? (live ? now : started)) - started,
    results:
      assessmentFamily.safeParse(declaration?.results?.family).data ?? null,
  };
}

function pageWorkOf(meta: Partial<RunStepMeta>): StepPageWork | null {
  if (!meta.page) return null;
  const entries = Object.entries(meta.page.timings);
  const measured = entries.reduce((sum, [, ms]) => sum + ms, 0);
  const totalMs = Math.max(measured, meta.timing?.lastPageMs ?? 0);
  if (totalMs <= 0) return null;
  return {
    phases: entries
      .map(([phase, ms]) => ({ phase, ms, share: ms / totalMs }))
      .sort((a, b) => b.ms - a.ms),
    totalMs,
    queries: meta.page.queries,
    concurrency: meta.page.concurrency ?? {},
  };
}

export type StepSegment = {
  key: string;
  label: string;
  phase: StepPhase;
  /** Count-mode fill; null draws a full (done) or sliding (tally) segment. */
  fraction: number | null;
  tally: boolean;
};

export type RunOverview = {
  steps: RunStepView[];
  /** The step running or waiting now, else the first not started, else the last. */
  current: RunStepView | null;
  currentIndex: number;
  segments: StepSegment[];
  /** What sets the Run's speed now (the limits catalog's evaluation). */
  binding: LimitBinding | null;
};

export function runOverview(
  detail: RunDetailStepsOut,
  jobs: JobListOut | undefined,
  now: number,
  input: RunDetailStepsOut["input"],
): RunOverview {
  const primary = jobs?.primary ?? null;
  const steps = declaredRunSteps(detail.purpose, input).map(
    (declaration, position) => {
      const stored = detail.steps.find((step) => step.key === declaration.key);
      return stepView(
        detail.purpose,
        stored ?? {
          key: declaration.key,
          label: declaration.label,
          position,
          state: "queued",
          found: 0,
          done: 0,
          failed: 0,
          skipped: 0,
          left: null,
          pages: 0,
          pausedReason: null,
          pausedUntil: null,
          startedAt: null,
          endedAt: null,
          errors: [],
          meta: null,
        },
        primary,
        now,
      );
    },
  );
  const moving = steps.findIndex((step) =>
    ["running", "waiting", "paused", "failed"].includes(step.phase),
  );
  const currentIndex =
    moving >= 0
      ? moving
      : steps.every((step) => step.phase === "done")
        ? steps.length - 1
        : steps.findIndex((step) => step.phase === "not_started");
  return {
    steps,
    current: steps[currentIndex] ?? null,
    currentIndex,
    segments: steps.map((step) => ({
      key: step.key,
      label: step.label,
      phase: step.phase,
      fraction: step.fraction,
      tally:
        step.mode !== "count" &&
        (step.phase === "running" || step.phase === "waiting"),
    })),
    binding: jobs?.binding ?? null,
  };
}

const lowerFirst = (text: string) =>
  /^[A-Z][a-z]/.test(text)
    ? text.charAt(0).toLowerCase() + text.slice(1)
    : text;

/**
 * The one line a RunStep card shows beside rate and ETA ("Speed set by page
 * work: preparation 61% of page time · 106 queries/page").
 */
export function speedSetBy(binding: LimitBinding | null): string | null {
  if (!binding) return null;
  if (binding.status === "binding")
    return `Speed set by ${lowerFirst(binding.label)}: ${binding.evidence}`;
  if (binding.status === "unknown")
    return "Speed set by: unknown — no recent samples";
  return `No limit is binding: ${lowerFirst(binding.reason)}`;
}

/* ——— Decisions ——— */

export const DECISION_STATUS_LABEL = {
  pending: "Needs review",
  applied: "Applied",
  rejected: "Rejected",
  superseded: "Replaced",
  resolved: "Review complete",
} as const satisfies Record<RunDecisionStatus, string>;

import { z } from "zod";
import { runShortcode } from "./identifiers";
import { dateTime } from "./codec";
import type { RunWaitingOn, RunWaitReason } from "./run-waiting-on";

export const jobState = z.enum([
  "queued",
  "running",
  "retry_wait",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type JobState = z.infer<typeof jobState>;

const jobWaitReasons = [
  "provider_capacity",
  "ai_funding_window",
  "device",
  "rate_limit",
] as const;
export const jobWaitReason = z.enum(jobWaitReasons);
export type JobWaitReason = z.infer<typeof jobWaitReason>;

/**
 * Why a derived value's stored refresh metadata reports an attempt-free wait.
 */
const workWaitCauses = ["search_coverage"] as const;
const workWaitCause = z.enum(workWaitCauses);
type WorkWaitCause = z.infer<typeof workWaitCause>;
const WORK_WAIT_CAUSE_TEXT = {
  search_coverage: "Waiting for search indexing",
} as const satisfies Record<WorkWaitCause, string>;

/** Who executes a Job kind; every waiting-on explanation names its lane. */
export const jobLane = z.enum([
  "apple_device",
  "frontier_ai",
  "server",
  "external",
]);
export type JobLane = z.infer<typeof jobLane>;

/**
 * What one live Job waits on, derived from its stored execution facts by
 * `generic/jobs/repo/waiting-on.ts`. Terminal Jobs wait on nothing (null).
 */
export const jobWaitingOn = z.discriminatedUnion("reason", [
  z.object({
    reason: z.literal("due"),
    lane: jobLane,
  }),
  z.object({
    reason: z.literal("waiting_device"),
    lane: jobLane,
  }),
  z.object({
    reason: z.literal("waiting_funding"),
    lane: jobLane,
    until: z.iso.datetime().nullable(),
  }),
  z.object({
    reason: z.literal("leased"),
    lane: jobLane,
    executor: z.string().nullable(),
    /** The leasing device's installation id as its executor assignment records it; null for cloud executors. */
    executorDeviceId: z.string().nullable(),
    /** When the current lease was claimed. */
    leasedAt: z.iso.datetime().nullable(),
    leaseExpiresAt: z.iso.datetime(),
    /** An expired lease is reclaimed by the next claim; the old executor lost it. */
    expired: z.boolean(),
  }),
  z.object({
    reason: z.literal("backing_off"),
    lane: jobLane,
    until: z.iso.datetime(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    /** A stored provider wait (`rate_limit`, `provider_capacity`), or the next WorkItem's explicit wait, when one set the time. */
    cause: z.enum([...jobWaitReasons, ...workWaitCauses]).nullable(),
  }),
  z.object({
    reason: z.literal("blocked"),
    lane: jobLane,
    by: z.string(),
  }),
  z.object({
    reason: z.literal("paused"),
    lane: jobLane,
    by: z.enum(["member", "run"]),
  }),
  z.object({
    reason: z.literal("update_required"),
    lane: jobLane,
    device: z.string(),
  }),
]);
export type JobWaitingOn = z.infer<typeof jobWaitingOn>;
export const jobWaitingOnReason = z.enum([
  "due",
  "waiting_device",
  "waiting_funding",
  "leased",
  "backing_off",
  "blocked",
  "paused",
  "update_required",
] satisfies readonly JobWaitingOn["reason"][]);
export type JobWaitingOnReason = z.infer<typeof jobWaitingOnReason>;

/** Failures after which never-exhausting work also shows as needing attention. */
export const JOB_NEEDS_ATTENTION_ATTEMPTS = 5;

const jobPayload = z.json();
export type JobPayload = z.infer<typeof jobPayload>;

export const enqueueJobInput = z.object({
  key: z.string().min(1),
  kind: z.string().min(1),
  input: jobPayload,
  runId: z.uuid().nullable().optional(),
  priority: z.number().int().optional(),
  /** Defaults to the kind policy. */
  maxAttempts: z.number().int().positive().optional(),
  availableAt: dateTime.optional(),
  /** Explicit new input or member retry; routine recovery never revives failures. */
  invalidate: z.boolean().optional(),
});
export type EnqueueJobInput = z.infer<typeof enqueueJobInput>;

/** Every Job and drain unit fails visibly after failing this long, whatever its error class. */
export const JOB_FAILING_LIMIT_MS = 24 * 60 * 60_000;

/** What one execution of a Job or drain unit did, recorded on its `Job` row. */
export const jobExecution = z.object({
  outcome: z.enum([
    "succeeded",
    "skipped",
    "superseded",
    "paused",
    "deferred",
    "failed",
  ]),
  /** The failure classification (`transient`, `failed`, ...) or the error's name; null on success. */
  errorClass: z.string().nullable(),
  wallMs: z.number().int().nonnegative(),
  queryCount: z.number().int().nonnegative(),
  queryMs: z.number().int().nonnegative(),
  /** Charged AI cost attributed to this Job during the execution; null when none is attributable. */
  aiCostUsd: z.number().nonnegative().nullable(),
  workerVersion: z.string().nullable(),
  /** Drain pages: claimed, published and failed items. */
  items: z
    .object({
      claimed: z.number().int().nonnegative(),
      published: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .optional(),
  finishedAt: z.iso.datetime(),
  /**
   * When the row's unbroken run of deferred executions began. A deferred
   * execution sets it and one that claimed nothing keeps it; any other
   * outcome drops it.
   */
  deferringSince: z.iso.datetime().optional(),
});
export type JobExecution = z.infer<typeof jobExecution>;

export const jobPage = z.object({
  done: z.boolean(),
  cursor: jobPayload.optional(),
  result: jobPayload.optional(),
  availableAt: dateTime.optional(),
  waitReason: jobWaitReason.optional(),
  waitUntil: dateTime.optional(),
});
export type JobPage = z.infer<typeof jobPage>;

export const JOB_LANE_LABEL = {
  apple_device: "Apple devices",
  frontier_ai: "Cloud AI",
  server: "Cubby server",
  external: "External services",
} as const satisfies Record<JobLane, string>;

const JOB_WAITING_ON_LABEL = {
  due: "Due",
  waiting_device: "Waiting for any Apple device",
  waiting_funding: "Waiting for AI funding",
  leased: "In progress",
  backing_off: "Backing off",
  blocked: "Blocked",
  paused: "Paused",
  update_required: "Update required",
} as const satisfies Record<JobWaitingOnReason, string>;

/** A rounded span ("40 s", "12 min", "3 h", "2 d"). */
function jobSpanText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}
const untilText = (iso: string, now: Date) => {
  const seconds = (Date.parse(iso) - now.getTime()) / 1000;
  return seconds > 0 ? `for ${jobSpanText(seconds)}` : "until now";
};

/**
 * One line naming what a Job waits on, for every text surface (generated
 * entity fields, Activity, explain). Raw errors stay in their own field.
 */
export function describeJobWaitingOn(
  waitingOn: JobWaitingOn | null,
  now = new Date(),
): string | null {
  if (!waitingOn) return null;
  switch (waitingOn.reason) {
    case "due":
      return "Due now";
    case "waiting_device":
      return JOB_WAITING_ON_LABEL.waiting_device;
    case "waiting_funding":
      return waitingOn.until
        ? `Waiting for AI funding ${untilText(waitingOn.until, now)}`
        : "Waiting for AI funding";
    case "leased": {
      const who = waitingOn.executor ?? "an executor";
      return waitingOn.expired
        ? `Lease on ${who} expired; waiting to be reclaimed`
        : `In progress on ${who}`;
    }
    case "backing_off":
      if (Date.parse(waitingOn.until) <= now.getTime()) return "Due now";
      if (waitingOn.cause === workWaitCause.enum.search_coverage)
        return `${WORK_WAIT_CAUSE_TEXT[waitingOn.cause]}; next attempt in ${jobSpanText((Date.parse(waitingOn.until) - now.getTime()) / 1000)}`;
      if (waitingOn.attempts === 0)
        return `Due in ${jobSpanText((Date.parse(waitingOn.until) - now.getTime()) / 1000)}`;
      return `Backing off ${untilText(waitingOn.until, now)} after ${waitingOn.attempts} ${waitingOn.attempts === 1 ? "failure" : "failures"}`;
    case "blocked":
      return `Blocked by ${waitingOn.by}`;
    case "paused":
      return waitingOn.by === "run" ? "Paused with its Run" : "Paused";
    case "update_required":
      return `${waitingOn.device} needs a Cubby update`;
  }
}

/**
 * A Run rollup's live Jobs as one line ("12 due · 3 in progress"), in the
 * fixed reason order; null when no live Job remains.
 */
export function describeJobRollup(
  counts: Partial<Record<JobWaitingOnReason, number>>,
  /** Running Jobs whose lease lapsed; they are live but in no `counts` reason. */
  expiredLeases = 0,
): string | null {
  const parts = jobWaitingOnReason.options.flatMap((reason) => {
    const count = counts[reason] ?? 0;
    const label = JOB_WAITING_ON_LABEL[reason];
    // Only the leading letter: "Apple" and "AI" keep their case.
    return count
      ? [`${count} ${label.charAt(0).toLowerCase()}${label.slice(1)}`]
      : [];
  });
  if (expiredLeases)
    parts.push(
      `${expiredLeases} expired ${expiredLeases === 1 ? "lease" : "leases"} awaiting reclaim`,
    );
  return parts.length ? parts.join(" · ") : null;
}

/** A failed page waits `baseMs · 2^(failures - 1)`, capped at `maxMs`. */
export type JobBackoff = { readonly baseMs: number; readonly maxMs: number };

export type JobKindPolicy = {
  readonly internal: boolean;
  readonly lane: JobLane;
  /**
   * Consecutive reported failures before the Job fails. Reclaiming an
   * expired lease counts as a failure, so a crash loop still exhausts.
   * Transient failures do not count, but any Job still failing after
   * `JOB_FAILING_LIMIT_MS` fails visibly.
   */
  readonly maxAttempts: number;
  readonly backoff: JobBackoff;
};

/** Location model work waits longer between attempts than ordinary server Jobs. */
const RECOVERABLE_BACKOFF = { baseMs: 60_000, maxMs: 15 * 60_000 };

const SERVER: JobKindPolicy = {
  internal: false,
  lane: "server",
  maxAttempts: 3,
  backoff: { baseMs: 1_000, maxMs: 60_000 },
};
/**
 * The one registry of per-kind execution policy. A kind absent here runs on
 * the server drain and fails after three consecutive failures.
 */
export type JobKindDeclaration = JobKindPolicy & {
  label: string;
  /** Member wording for this kind of work on the Work page. */
  activityLabel?: string;
  /** What a member sees when this kind stops; undeclared kinds fall back to their label. */
  stuck?: { title?: string; failingTitle?: string; consequence: string };
  purpose: string;
  trigger: string;
  targets: string;
  effects: string;
  dependencies: string;
  cost: string;
  exclusions: string;
};

export const JOB_KIND_POLICY = {
  "purchase.dispatch": {
    stuck: { consequence: "New purchases won't import until this works." },
    activityLabel: "Purchase import",
    label: "Dispatch purchase research",
    purpose: "Delivers admitted purchase work to its configured agent host.",
    trigger: "Purchase workflow dispatch.",
    targets: "The queued purchase dispatch event.",
    effects: "Delivers the event and records the dispatch outcome.",
    dependencies: "Configured purchase agent host and its credentials.",
    cost: "The receiving agent’s work follows its own usage policy.",
    exclusions:
      "Duplicate or ineligible dispatches follow existing dispatch reconciliation.",
    ...SERVER,
    lane: "external",
  },
  "run.execute": {
    activityLabel: "Runs",
    ...SERVER,
    label: "Execute a Run",
    purpose: "Advances the workflow declared by the owning Run type.",
    trigger: "Run admission, continuation or supported retry.",
    targets: "The owning Run and its current execution checkpoint.",
    effects:
      "Executes declared steps, AI work or mailbox discovery; writes outcomes to the Run.",
    dependencies: "The dependencies declared by the Run type.",
    cost: "Depends on the Run type; inspect its definition and recorded usage.",
    exclusions:
      "Paused, cancelled and ineligible work obeys the Run’s existing control policy.",
  },
  "run.funding-resume": {
    ...SERVER,
    label: "Resume funded Runs",
    purpose:
      "Resumes eligible funding-paused work after the funding window ends.",
    trigger: "A funding-window wait.",
    targets: "Funding-paused Runs eligible when the window expires.",
    effects: "Rechecks funding-paused work and resumes eligible execution.",
    dependencies: "Funding policy and the scheduled window deadline.",
    cost: "Resumed work may incur AI charges within its funding policy.",
    exclusions:
      "Does not bypass funding eligibility or force a member-paused Run.",
  },
  "location-ai.description.refresh": {
    ...SERVER,
    maxAttempts: 10,
    backoff: RECOVERABLE_BACKOFF,
    label: "Describe a Location",
    purpose: "Refreshes the AI description for a Location.",
    trigger: "Location description refresh request.",
    targets: "The requested Location and current evidence.",
    effects: "Records an eligible Location description result.",
    dependencies: "Location evidence and configured AI model.",
    cost: "AI funding policy applies.",
    exclusions: "Results are applied only under the owning field policy.",
  },
  "location-ai.inventory.refresh": {
    ...SERVER,
    maxAttempts: 10,
    backoff: RECOVERABLE_BACKOFF,
    label: "Analyze Location inventory",
    purpose: "Refreshes inventory analysis for a Location.",
    trigger: "Location inventory analysis request.",
    targets: "The requested Location and available inventory evidence.",
    effects: "Records analysis; deliberate inventory changes remain explicit.",
    dependencies: "Location inventory evidence and configured model.",
    cost: "AI funding policy applies.",
    exclusions: "Analysis alone does not receive or deduct stock.",
  },
  "run-ai.summary.write": {
    ...SERVER,
    maxAttempts: 6,
    backoff: RECOVERABLE_BACKOFF,
    label: "Summarize an ended Run",
    activityLabel: "Run summaries",
    purpose: "Writes the AI summary shown in an ended Run's header.",
    trigger: "A Run in the default Runs list reaching its end state.",
    targets: "One ended Run and its recorded title, cause, outcome and steps.",
    effects:
      "Records one AI summary for that end; the Run's status, cost and progress are unchanged.",
    dependencies: "The fast AI tier and the AI funding window.",
    cost: "One short fast-tier call per ended Run, recorded as automatic AI usage.",
    exclusions:
      "Runs that ended before summaries existed, hidden automatic Runs, and Runs that changed again before the summary was written.",
  },
  "image-metadata.extract": {
    ...SERVER,
    label: "Extract image metadata",
    purpose: "Reads embedded capture time and location from an image.",
    trigger: "Image metadata extraction request.",
    targets: "The requested uploaded Image original.",
    effects: "Records extracted metadata or a diagnostic outcome.",
    dependencies: "Readable original image storage.",
    cost: "No AI model call is required for EXIF extraction.",
    exclusions:
      "Missing originals and unsupported metadata retain their recorded outcome.",
  },
  "maintenance.purchase-discovery": {
    ...SERVER,
    label: "Discover purchase work",
    purpose: "Requests the purchase discovery maintenance operation.",
    trigger: "Purchase discovery maintenance request.",
    targets:
      "Eligible purchase discovery backlog under the owning maintenance operation.",
    effects:
      "Admits eligible purchase work through the existing purchase workflow.",
    dependencies: "Purchase discovery configuration and source evidence.",
    cost: "Downstream work follows its model and funding policy.",
    exclusions: "Eligibility remains owned by purchase discovery.",
  },
  "background.drain": {
    ...SERVER,
    internal: true,
    label: "Background drain page",
    purpose:
      "Records the latest page of one drain unit (cloud images, embeddings, AI evaluation, derived rebuild, reconciliation).",
    trigger: "A background permit selecting that unit.",
    targets: "The rows the drain unit owes; its record row holds no work.",
    effects: "Records when the unit last ran and that execution's outcome.",
    dependencies: "The drain's own rows and providers.",
    cost: "Follows the drain's own model and provider policy.",
    exclusions:
      "Never claimed or executed as a Job; item retries live on the drain's rows.",
  },

} as const satisfies Record<string, JobKindDeclaration>;

const POLICY_BY_KIND: ReadonlyMap<string, JobKindDeclaration> = new Map(
  Object.entries(JOB_KIND_POLICY),
);
export const jobKindDeclaration = (
  kind: string,
): JobKindDeclaration | undefined => POLICY_BY_KIND.get(kind);
export const jobKindPolicy = (kind: string): JobKindPolicy =>
  jobKindDeclaration(kind) ?? SERVER;

/** Aggregate progress and the last three wall-clock rebuild durations, excluding AI/embedding regeneration. */
const rebuildObservation = z.object({
  running: z.boolean(),
  target: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  failures: z.int().nonnegative(),
  error: z.string().nullable(),
  durationsMs: z.array(z.number().nonnegative()),
  lastMovementAt: z.iso.datetime().nullable(),
  cleanAt: z.iso.datetime().nullable(),
  pages: z.int().nonnegative(),
  processedRecords: z.int().nonnegative(),
  failedPages: z.int().nonnegative(),
  history: z.array(
    z.object({
      startedAt: z.string(),
      finishedAt: z.string(),
      durationMs: z.number(),
      pages: z.int(),
      processedRecords: z.int(),
      failedPages: z.int(),
    }),
  ),
});

/**
 * One kind of work (a Job kind): what runs and
 * waits now, recent completions and failures, and the active Runs it serves.
 * `completedPerMinute` averages the pace window; it is a measurement, not a
 * forecast, so a stream without recent completions reports 0.
 */
const workStream = z.object({
  kind: z.string(),
  running: z.number().int().nonnegative(),
  due: z.number().int().nonnegative(),
  backingOff: z.number().int().nonnegative(),
  scheduled: z.number().int().nonnegative(),
  paused: z.number().int().nonnegative(),
  completedPerMinute: z.number().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  lastCompletedAt: z.iso.datetime().nullable(),
  oldestDueAt: z.iso.datetime().nullable(),
  runIds: z.array(runShortcode),
});
/**
 * Waiting Jobs of one kind that share a wait: why they wait, whose Runs they
 * are, and the Runs at the head of the kind's claim order.
 */
/** A stored wait reason, `retry` after a failure, or `turn` for plain queued work. */
export const workQueueWaitReason = z.enum([...jobWaitReasons, "retry", "turn"]);

const workQueueWait = z.object({
  reason: workQueueWaitReason,
  /** The owning Runs' purpose; null when the Jobs belong to no Run. */
  runPurpose: z.string().nullable(),
  count: z.number().int().nonnegative(),
  /** How many of them deferred on their latest execution. */
  deferred: z.number().int().nonnegative(),
  /** The group in one sentence, e.g. "115 Mail discovery Runs keep deferring on provider capacity." */
  summary: z.string(),
  /** Up to three owning Runs, first in claim order. */
  runIds: z.array(runShortcode),
});
export type WorkQueueWait = z.infer<typeof workQueueWait>;

/**
 * What the queue did for one permit unit (a Job kind or a drain unit) within
 * `windows.outcomeMinutes`. Only each row's latest execution is stored, so
 * `claimed` counts rows claimed in the window and the outcome counts are rows
 * by their latest execution, never executions: a Job that deferred forty times
 * counts once. A drain unit has one record row, so its counts are 0 or 1 and
 * `lastExecution` carries the page's item counts.
 */
const workQueueUnit = z.object({
  unit: z.string(),
  type: z.union([z.literal("job"), z.literal("drain")]),
  label: z.string(),
  claimed: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  lastClaimedAt: z.iso.datetime().nullable(),
  /** The longest-waiting claimable work; a drain unit reads its stream's. */
  oldestDueAt: z.iso.datetime().nullable(),
  /** Live leases: Jobs an executor holds, or a drain's leased items. */
  leased: z.number().int().nonnegative(),
  /** Jobs whose lease lapsed unreclaimed. */
  expiredLeases: z.number().int().nonnegative(),
  /** A drain unit's latest page; null for a Job kind. */
  lastExecution: jobExecution.nullable(),
  /** A Job kind's waiting Jobs by cause, largest group first. */
  waits: z.array(workQueueWait),
});
export type WorkQueueUnit = z.infer<typeof workQueueUnit>;

/**
 * AI evaluations of one feature in one state. `oldestAt` is the oldest row's
 * creation; `errorClass` is the most common stored error's name. `blocked`
 * counts rows blocked within `windows.blockedDays`.
 */
const aiEvaluationBacklog = z.object({
  feature: z.string(),
  label: z.string(),
  state: z.enum(["queued", "result_ready", "blocked"]),
  count: z.number().int().positive(),
  oldestAt: z.iso.datetime(),
  errorClass: z.string().nullable(),
});
export type AiEvaluationBacklog = z.infer<typeof aiEvaluationBacklog>;

export const workActivity = z.object({
  rebuild: rebuildObservation,
  measuredAt: z.iso.datetime(),
  windows: z.object({
    paceMinutes: z.number().int().positive(),
    completedMinutes: z.number().int().positive(),
    failedMinutes: z.number().int().positive(),
    outcomeMinutes: z.number().int().positive(),
    blockedDays: z.number().int().positive(),
  }),
  streams: z.array(workStream),
  /** Every permit unit that is live or ran within `windows.outcomeMinutes`. */
  queue: z.array(workQueueUnit),
  evaluations: z.array(aiEvaluationBacklog),
});
export type WorkActivity = z.infer<typeof workActivity>;

export { runWaitingOn, type RunWaitingOn } from "./run-waiting-on";

/** Waiting Jobs of one kind and wait owned by one Run, placed in the kind's claim order. */
export type RunWaitGroup = {
  kind: string;
  reason: z.infer<typeof workQueueWaitReason>;
  /** This Run's Jobs in the group. */
  mine: number;
  /**
   * The Run's first due Job of the group in the kind's claim order across
   * every due Job of the kind (`dueUnits`), 1-based; null while none is due.
   */
  position: number | null;
  /** Due Jobs of the kind; null while none of the Run's is due. */
  total: number | null;
  /** The earliest `availableAt` among this Run's Jobs in the group. */
  nextAt: Date;
  errorClass: string | null;
};

const GROUP_REASON = {
  ai_funding_window: "funding",
  provider_capacity: "model_capacity",
  rate_limit: "rate_limit",
  retry: "retry",
  device: "device",
  turn: "queued",
} as const satisfies Record<RunWaitGroup["reason"], RunWaitReason>;

/** Fallback when no Job waits in a group (image rows, leases, pauses), by precedence. */
const COUNT_REASON: readonly [JobWaitingOnReason, RunWaitReason][] = [
  ["waiting_funding", "funding"],
  ["leased", "in_progress"],
  ["backing_off", "retry"],
  ["due", "queued"],
  ["waiting_device", "device"],
  ["update_required", "device"],
  ["blocked", "blocked"],
  ["paused", "paused"],
];

/** Each wait in the stage words (ADR 0029 section 10): Waiting, Working or Stuck, then the input. */
const RUN_WAIT_TEXT = {
  funding: "Waiting for AI funding",
  model_capacity: "Waiting for model capacity",
  rate_limit: "Waiting for a provider rate limit",
  retry: "Waiting to retry",
  device: "Waiting for an Apple device",
  queued: "Waiting for Cubby",
  in_progress: "Working",
  reclaim: "Waiting for Cubby to pick it up again",
  blocked: "Stuck",
  paused: "Waiting while paused",
} as const satisfies Record<RunWaitReason, string>;

/** Reasons whose ETA is the Run's place in line at the kind's pace. */
const PACED: ReadonlySet<RunWaitReason> = new Set([
  "model_capacity",
  "rate_limit",
  "device",
  "queued",
]);

/** When `position` Jobs drain at `perMinute`; null without a pace. */
function queueEtaAt(
  position: number,
  perMinute: number | null,
  now: Date,
): Date | null {
  if (!perMinute || perMinute <= 0) return null;
  return new Date(now.getTime() + (position / perMinute) * 60_000);
}

/** "less than a minute", "about 16 min", "about 2 h", "about 3 d". */
export function aboutSpanText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 90) return `about ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `about ${hours} h` : `about ${Math.round(hours / 24)} d`;
}

/** 1st, 2nd, 3rd, 4th, 11th, 22nd. */
export function ordinalText(value: number): string {
  const tens = value % 100;
  const ones = value % 10;
  const suffix =
    tens >= 11 && tens <= 13
      ? "th"
      : ones === 1
        ? "st"
        : ones === 2
          ? "nd"
          : ones === 3
            ? "rd"
            : "th";
  return `${value}${suffix}`;
}

/**
 * A Run wait as one line: the reason, the place in line, and when it should
 * end. `formatTime` names a clock time ("6:00 AM") in the household zone.
 */
export function describeRunWait(
  wait: Omit<RunWaitingOn, "label" | "jobs">,
  now: Date,
  formatTime: (at: Date) => string,
): string {
  const head =
    wait.reason === "retry" && wait.errorClass
      ? `${RUN_WAIT_TEXT.retry} (${wait.errorClass})`
      : RUN_WAIT_TEXT[wait.reason];
  const parts: string[] = [head];
  if (wait.position !== null && wait.total !== null)
    parts.push(`${ordinalText(wait.position)} of ${wait.total}`);
  const eta = wait.etaAt ? new Date(wait.etaAt) : null;
  const left = eta ? eta.getTime() - now.getTime() : 0;
  if (wait.reason === "funding") {
    if (eta && left > 0) parts.push(`resumes ${formatTime(eta)}`);
  } else if (wait.reason === "retry") {
    if (eta && left > 0) parts.push(`next try in ${aboutSpanText(left)}`);
  } else if (PACED.has(wait.reason)) {
    parts.push(eta ? aboutSpanText(Math.max(0, left)) : "pace unknown");
  }
  return parts.join(" · ");
}

/**
 * The dominant wait among a Run's live work. A funding wait holds every AI
 * step, so it leads; otherwise the group holding most of the Run's waiting
 * Jobs, then live leases, then the remaining counts.
 */
export function summarizeRunWait(input: {
  now: Date;
  formatTime: (at: Date) => string;
  /** The Run itself is paused for the AI funding window. */
  waitingForFunding: boolean;
  /** When that window's resume is scheduled; null when none is queued. */
  fundingResumeAt: Date | null;
  groups: readonly RunWaitGroup[];
  /** Completions per minute by Job kind over `paceMinutes`. */
  perMinute: ReadonlyMap<string, number>;
  paceMinutes: number;
  counts: Partial<Record<JobWaitingOnReason, number>>;
  expiredLeases: number;
}): RunWaitingOn | null {
  const { now, paceMinutes } = input;
  const jobs = describeJobRollup(input.counts, input.expiredLeases);
  const base = {
    kind: null,
    position: null,
    total: null,
    perMinute: null,
    paceMinutes,
    etaAt: null,
    errorClass: null,
  };
  const finish = (wait: Omit<RunWaitingOn, "label" | "jobs">) => ({
    ...wait,
    label: describeRunWait(wait, now, input.formatTime),
    jobs,
  });
  if (input.waitingForFunding)
    return finish({
      ...base,
      reason: "funding",
      etaAt: input.fundingResumeAt?.toISOString() ?? null,
    });
  const order = Object.keys(GROUP_REASON);
  const group = [...input.groups].sort(
    (left, right) =>
      Number(right.reason === "ai_funding_window") -
        Number(left.reason === "ai_funding_window") ||
      right.mine - left.mine ||
      order.indexOf(left.reason) - order.indexOf(right.reason) ||
      left.kind.localeCompare(right.kind),
  )[0];
  if (group) {
    const reason = GROUP_REASON[group.reason];
    const perMinute = input.perMinute.get(group.kind) ?? 0;
    // The kind drains its whole due queue at its pace, so a due Job's ETA is
    // its place in that queue; one not yet due waits for its own time.
    const position = PACED.has(reason) ? group.position : null;
    const etaAt =
      position === null ? group.nextAt : queueEtaAt(position, perMinute, now);
    return finish({
      ...base,
      reason,
      kind: group.kind,
      position,
      total: position === null ? null : group.total,
      perMinute: perMinute > 0 ? perMinute : null,
      etaAt: etaAt?.toISOString() ?? null,
      errorClass: reason === "retry" ? group.errorClass : null,
    });
  }
  const counted = COUNT_REASON.find(([key]) => (input.counts[key] ?? 0) > 0);
  if (counted) return finish({ ...base, reason: counted[1] });
  return input.expiredLeases ? finish({ ...base, reason: "reclaim" }) : null;
}

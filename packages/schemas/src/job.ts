import { z } from "zod";
import { runShortcode } from "./identifiers";
import { dateTime } from "./codec";

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
  "calendar-feed.mark-dirty": {
    ...SERVER,
    label: "Refresh calendar feed",
    purpose: "Marks the calendar feed for regeneration.",
    trigger: "A calendar-relevant change.",
    targets: "The household calendar feed.",
    effects: "Invalidates the feed so it can reflect current records.",
    dependencies: "Calendar configuration and current source records.",
    cost: "No AI call is required.",
    exclusions: "Does not edit unrelated household records.",
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
export const workActivity = z.object({
  rebuild: rebuildObservation,
  measuredAt: z.iso.datetime(),
  windows: z.object({
    paceMinutes: z.number().int().positive(),
    completedMinutes: z.number().int().positive(),
    failedMinutes: z.number().int().positive(),
  }),
  streams: z.array(workStream),
});
export type WorkActivity = z.infer<typeof workActivity>;

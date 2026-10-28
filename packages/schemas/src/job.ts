import { z } from "zod";
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

export const jobWaitReasons = [
  "provider_capacity",
  "ai_funding_window",
  "device",
  "rate_limit",
] as const;
export const jobWaitReason = z.enum(jobWaitReasons);
export type JobWaitReason = z.infer<typeof jobWaitReason>;

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
    /** A stored provider wait (`rate_limit`, `provider_capacity`), when one set the time. */
    cause: jobWaitReason.nullable(),
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

export const jobPayload = z.json();
export type JobPayload = z.infer<typeof jobPayload>;

export const enqueueJobInput = z.object({
  key: z.string().min(1),
  kind: z.string().min(1),
  input: jobPayload,
  runId: z.uuid().nullable().optional(),
  subjectKind: z.string().min(1).nullable().optional(),
  subjectId: z.string().min(1).nullable().optional(),
  priority: z.number().int().optional(),
  /** Defaults to the kind policy; null never exhausts. */
  maxAttempts: z.number().int().positive().nullable().optional(),
  availableAt: dateTime.optional(),
  /** Explicit new input or member retry; routine recovery never revives failures. */
  invalidate: z.boolean().optional(),
});
export type EnqueueJobInput = z.infer<typeof enqueueJobInput>;

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

export const JOB_WAITING_ON_LABEL = {
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
  /** False: only an external executor's pull claims it; the server drain never does. */
  readonly drained: boolean;
  /**
   * Consecutive reported failures before the Job fails. Null never exhausts:
   * subject-owned work and drains back off forever. Reclaiming an expired
   * lease counts as a failure, so a crash loop still exhausts.
   */
  readonly maxAttempts: number | null;
  readonly backoff: JobBackoff;
  /** Live leases of this kind across every drain; Run-owned work is exempt. */
  readonly maxInFlight?: number;
};

const IMAGE_BACKOFF = { baseMs: 30_000, maxMs: 24 * 60 * 60_000 };
const MAINTENANCE_BACKOFF = { baseMs: 60_000, maxMs: 15 * 60_000 };

const SERVER: JobKindPolicy = {
  internal: false,
  lane: "server",
  drained: true,
  maxAttempts: 3,
  backoff: { baseMs: 1_000, maxMs: 60_000 },
};
/** Self-arming pages and drains: a failure backs off, never stops the Job. */
const MAINTENANCE: JobKindPolicy = {
  ...SERVER,
  internal: true,
  maxAttempts: null,
  backoff: MAINTENANCE_BACKOFF,
};
/** A drain Job owns no work of its own; its items retry on their own rows. */
const DRAIN: JobKindPolicy = { ...MAINTENANCE, internal: false };

/**
 * The one registry of per-kind execution policy. A kind absent here runs on
 * the server drain and fails after three consecutive failures.
 */
export type JobKindDeclaration = JobKindPolicy & {
  label: string;
  /** Summary wording used by the current-work feed. */
  activityLabel?: string;
  purpose: string;
  trigger: string;
  targets: string;
  effects: string;
  dependencies: string;
  cost: string;
  exclusions: string;
};

export const JOB_KIND_POLICY = {
  // Image processing is never abandoned (docs/jobs.md#image-processing).
  "image.cloud": {
    activityLabel: "Photo processing in the cloud",
    label: "Cloud image processing",
    purpose: "Describes eligible images using the configured vision model.",
    trigger: "Image processing admission.",
    targets: "An uploaded Image and its current processor revision.",
    effects: "Records image analysis and its source evidence.",
    dependencies: "Readable original; configured AI model and funding.",
    cost: "Paid AI work uses the current funding policy.",
    exclusions: "Deleted, replaced or superseded image work is retired.",

    ...SERVER,
    lane: "frontier_ai",
    maxAttempts: null,
    backoff: IMAGE_BACKOFF,
  },
  // Parked for Apple devices: their pull claims it; enqueue and connect ring them.
  "image.device": {
    activityLabel: "Photo processing on Apple devices",
    label: "Apple image processing",
    purpose: "Processes an Image using an available Apple companion.",
    trigger: "Image processing admission and device pull.",
    targets: "An uploaded Image and its current device processor revision.",
    effects:
      "Produces the requested cutout or on-device analysis while retaining the original.",
    dependencies: "A compatible connected Apple device and the original image.",
    cost: "On-device work; cloud work, if separately requested, has its own policy.",
    exclusions:
      "Only supported device work is claimed; moot work is retired by the server.",

    ...SERVER,
    lane: "apple_device",
    drained: false,
    maxAttempts: null,
    backoff: IMAGE_BACKOFF,
  },
  // Rings companions when parked device work comes due (docs/jobs.md#image-processing).
  "image.device.wake": {
    ...MAINTENANCE,
    label: "Wake Apple companions",
    purpose: "Notifies connected companions that device work is due.",
    trigger: "Device work admission, connection and due-time wake.",
    targets: "Connections eligible to receive a device-work notification.",
    effects: "Sends a wake notification; does not process images itself.",
    dependencies: "A connected companion can receive the notification.",
    cost: "No AI call is made by this wake Job.",
    exclusions: "No open connection is not an execution failure.",
  },
  "jobs.maintenance": {
    ...MAINTENANCE,
    label: "Internal queue upkeep",
    purpose: "Repairs queue execution and prunes old completed queue records.",
    trigger: "Periodic internal upkeep, re-armed every five minutes.",
    targets:
      "Missing image execution and old completed or cancelled Jobs eligible for retention cleanup.",
    effects:
      "Repairs image execution and device wake; every six hours prunes retained queue records in bounded pages.",
    dependencies: "Database and queue execution.",
    cost: "No AI call is made by queue upkeep.",
    exclusions:
      "Failed Jobs and domain evidence remain. This is separate from the nightly maintenance Run.",
  },
  "ai-refresh.activate": {
    label: "Activate AI refresh",
    purpose: "Admits refresh work after AI policy or input changes.",
    trigger: "AI refresh activation.",
    targets: "Eligible stale AI evaluations.",
    effects:
      "Creates or wakes refresh work under the existing admission policy.",
    dependencies: "Current evaluation inputs and policy.",
    cost: "Admitted evaluations can use AI funding; activation is coordination.",
    exclusions:
      "Current or ineligible evaluations are excluded by admission rules.",
    ...SERVER,
    internal: true,
  },
  "derived.drain": {
    ...MAINTENANCE,
    // Each failed mark backs off on its own row; the Job itself never stops.
    backoff: { baseMs: 30_000, maxMs: 15 * 60_000 },
    label: "Update derived values",
    purpose: "Recomputes outstanding declared derived fields.",
    trigger: "Changes that invalidate derived values.",
    targets: "Pending derived values selected by the generic derived runtime.",
    effects: "Writes computed values and propagates declared dependencies.",
    dependencies: "Source records and each field’s declared computation.",
    cost: "Individual computations follow their declared service policy.",
    exclusions:
      "Explicit field values and eligibility follow the owning field-resolution policy.",
  },
  "derived.reconcile": {
    ...MAINTENANCE,
    label: "Reconcile derived work",
    purpose:
      "Reconciles outstanding derived work with declared computation policy.",
    trigger: "Periodic derived reconciliation.",
    targets: "Derived work covered by the reconciliation pass.",
    effects: "Repairs derived scheduling through the existing runtime.",
    dependencies: "Derived declarations and current record state.",
    cost: "No blanket AI charge; individual downstream computations own cost.",
    exclusions: "Does not introduce a second derived-value policy.",
  },
  // One drain per feature; two pages at once leave the other lanes free.
  "ai.evaluation": {
    activityLabel: "AI evaluations",
    label: "AI evaluation",
    purpose: "Executes admitted AI evaluations.",
    trigger: "Evaluation admission by a Run or record workflow.",
    targets: "Eligible evaluation rows selected by the drain.",
    effects:
      "Records model output, charged usage and eligible published results.",
    dependencies:
      "Current evidence, configured model, provider capacity and funding.",
    cost: "Paid AI work; funding and provider waits remain visible.",
    exclusions:
      "Obsolete evidence and ineligible evaluations follow existing evaluation policy.",
    ...DRAIN,
    lane: "frontier_ai",
    maxInFlight: 2,
  },
  "embedding.refresh": {
    activityLabel: "Search embeddings",
    ...DRAIN,
    label: "Refresh search embeddings",
    purpose: "Builds missing or outdated search embeddings.",
    trigger: "Search document changes and embedding admission.",
    targets: "Eligible search documents awaiting a current embedding.",
    effects:
      "Calls the embedding service and stores the resulting search vector.",
    dependencies: "Current search document and embedding service.",
    cost: "External embedding service usage follows its configuration.",
    exclusions: "Retired or no-longer-eligible documents are excluded.",
  },
  "embedding.cleanup": {
    activityLabel: "Embedding cleanup",
    ...DRAIN,
    label: "Clean up search embeddings",
    purpose: "Removes vectors retired by the search lifecycle.",
    trigger: "Search vector retirement.",
    targets: "Retired embedding vectors queued for cleanup.",
    effects: "Deletes retired vectors from the external index.",
    dependencies: "Embedding index availability.",
    cost: "External index requests; no decision-model call.",
    exclusions: "Live search vectors are outside retired-vector cleanup.",
  },
  "purchase.dispatch": {
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
  "assessment.correction": {
    activityLabel: "Suggestion corrections",
    ...SERVER,
    label: "Propagate a correction",
    purpose: "Propagates a recorded correction through assessment policy.",
    trigger: "A supported correction action.",
    targets: "Assessments affected by the correction.",
    effects:
      "Updates correction-dependent assessment work under the owning policy.",
    dependencies: "Recorded correction and assessment evidence.",
    cost: "Any downstream AI work uses its configured funding policy.",
    exclusions:
      "Unrelated assessments and explicit decisions remain governed by their owners.",
  },
  "discovery.connections": {
    activityLabel: "Connection discovery",
    ...SERVER,
    label: "Discover connections",
    purpose: "Admits connection evaluation for changed records.",
    trigger: "Changed connection inputs.",
    targets: "Records eligible under declared connection rules.",
    effects: "Starts connection discovery work and eligible evaluations.",
    dependencies: "Current connection evidence and configured models.",
    cost: "Admitted AI evaluations use AI funding.",
    exclusions: "Unchanged or ineligible inputs are excluded.",
  },
  "location-ai.description.refresh": {
    ...SERVER,
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

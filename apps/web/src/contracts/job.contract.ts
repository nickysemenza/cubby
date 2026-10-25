import { runShortcode } from "@cubby/schemas/identifiers";
import {
  jobLane,
  jobState,
  jobWaitingOn,
  jobWaitingOnReason,
  jobWaitReason,
} from "@cubby/schemas/job";
import { SHORTCODE_BODY_PATTERN, SHORTCODE_PREFIX } from "@cubby/shared";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

/** `job.explain` names a Run, image job or Email by code, or a Job by id. */
const explainTarget = z
  .string()
  .trim()
  .regex(
    new RegExp(
      `^(?:(?:${[SHORTCODE_PREFIX.run, SHORTCODE_PREFIX.imageJob, SHORTCODE_PREFIX.email].join("|")})${SHORTCODE_BODY_PATTERN}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`,
      "i",
    ),
    "Expected a RUN-, IPR- or EML- code or a Job id",
  );

/** One Job as diagnostics read it: execution facts only, never domain state. */
const jobFacts = z.object({
  id: z.uuid(),
  key: z.string(),
  kind: z.string(),
  state: jobState,
  generation: z.number().int(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  priority: z.number().int(),
  waitReason: jobWaitReason.nullable(),
  waitUntil: z.iso.datetime().nullable(),
  availableAt: z.iso.datetime(),
  leaseExpiresAt: z.iso.datetime().nullable(),
  /** The raw failure as stored; only `scrubErrorMessage` redacted it. */
  error: z.string().nullable(),
  cursor: z.json().nullable(),
  subject: z.object({ kind: z.string(), id: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Due Jobs the fair drain serves first; null when not due. */
  ahead: z.number().int().nonnegative().nullable(),
  lane: jobLane,
  /** What the Job waits on now (`generic/jobs/repo/waiting-on.ts`); null when terminal. */
  waitingOn: jobWaitingOn.nullable(),
  /** The Run that owns it, as its public code. */
  runId: runShortcode.nullable(),
});
export type JobFacts = z.infer<typeof jobFacts>;

/** A Run's live Jobs by what they wait on, and whether it stopped progressing. */
const runRollup = z.object({
  runId: runShortcode,
  /** Live Jobs per waiting-on reason; terminal Jobs are not counted. */
  counts: z.partialRecord(jobWaitingOnReason, z.number().int().nonnegative()),
  /** The Run itself waits for AI funding (paused, or a legacy review stop). */
  waitingForFunding: z.boolean(),
  /** Latest claim or completion across the Run's Jobs. */
  lastProgressAt: z.iso.datetime().nullable(),
  /** Live Jobs remain but none was claimed or finished for `stallMinutes`. */
  stalled: z.boolean(),
  stallMinutes: z.number().int().positive(),
});
export type RunRollup = z.infer<typeof runRollup>;

/** A filtered Job set: every key narrows; an empty filter is every live Job. */
const jobSetFilter = z.strictObject({
  lanes: z.array(jobLane).min(1).optional(),
  kinds: z.array(z.string().min(1)).min(1).max(50).optional(),
  reasons: z.array(jobWaitingOnReason).min(1).optional(),
  states: z.array(jobState).min(1).optional(),
  runId: runShortcode.optional(),
  /** Never-exhausted work past its attention threshold, plus failed Jobs. */
  needsAttention: z.boolean().optional(),
  ids: z.array(z.uuid()).min(1).max(500).optional(),
});
export type JobSetFilter = z.infer<typeof jobSetFilter>;

const jobQueueOut = z.object({
  /** Live Jobs per lane and waiting-on reason, for the whole filtered set. */
  counts: z.array(
    z.object({
      lane: jobLane,
      reason: jobWaitingOnReason,
      count: z.number().int().nonnegative(),
    }),
  ),
  total: z.number().int().nonnegative(),
  /** The set's leased image work per executor; expired leases await reclaim. */
  leases: z.array(
    z.object({
      executor: z.string().nullable(),
      live: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
    }),
  ),
  jobs: z.array(jobFacts),
});

/** One kind's queue health as the watchdog measured it. */
const kindHealth = z.object({
  kind: z.string(),
  lane: jobLane,
  due: z.number().int().nonnegative(),
  oldestDueSeconds: z.number().int().nonnegative().nullable(),
  claimsPerMinute: z.number().nonnegative(),
  dueGrowth: z.number().int().nullable(),
  expiredLeases: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
});
const queueAlert = z.object({
  kind: z.string().nullable(),
  code: z.enum([
    "oldest_due",
    "no_claims",
    "due_growth",
    "expired_leases",
    "image_disagreement",
    "over_capacity",
  ]),
  /** The raw numbers that tripped it, verbatim. */
  evidence: z.string(),
});
export const queueHealthSnapshot = z.object({
  measuredAt: z.iso.datetime(),
  kinds: z.array(kindHealth),
  /** Open image rows whose Job is missing, stopped or finished. */
  imageDisagreement: z.number().int().nonnegative(),
  alerts: z.array(queueAlert),
});
export type QueueHealthSnapshot = z.infer<typeof queueHealthSnapshot>;

/** One link of an explain chain: a record, its state and what it waits on. */
const explainStep = z.object({
  ref: z.string(),
  kind: z.enum(["run", "imageJob", "email", "job"]),
  label: z.string(),
  state: z.string(),
  waitingOn: jobWaitingOn.nullable(),
  detail: z.string().nullable(),
});
const explainOut = z.object({
  steps: z.array(explainStep),
  rollup: runRollup.nullable(),
});

/** Fan-out Jobs of one kind (a step's per-item evaluations) as counts. */
const jobGroup = z.object({
  kind: z.string(),
  count: z.number().int().nonnegative(),
  states: z.partialRecord(jobState, z.number().int().nonnegative()),
  waitReasons: z.partialRecord(jobWaitReason, z.number().int().nonnegative()),
  latest: jobFacts,
});
export type JobGroup = z.infer<typeof jobGroup>;

const limitScope = z.enum([
  "queue",
  "drain",
  "job lease",
  "step page",
  "AI gateway",
  "funding",
  "database",
  "provider",
]);

/** One limit Cubby imposes, read from the constant or config that enforces it. */
const limitEntry = z.object({
  key: z.string(),
  label: z.string(),
  scope: limitScope,
  value: z.number(),
  unit: z.string(),
  /** Where the enforcing value is defined (file and constant or config key). */
  source: z.string(),
  /** Live use against the limit, when state shows it ("1 of 2 running"). */
  utilization: z.string().nullable(),
  /** In-page concurrency caps: the page phase the cap bounds. */
  phase: z.string().nullable(),
});
export type LimitEntry = z.infer<typeof limitEntry>;

/**
 * Which limit sets the Run's speed now, derived from Job and step state.
 * `unknown` means the evidence is missing, never a guess.
 */
const limitBinding = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("binding"),
    /** A catalog key, or null for a wait no catalog value governs (a device). */
    key: z.string().nullable(),
    label: z.string(),
    evidence: z.string(),
  }),
  z.object({ status: z.literal("none"), reason: z.string() }),
  z.object({ status: z.literal("unknown"), reason: z.string() }),
]);
export type LimitBinding = z.infer<typeof limitBinding>;

/** Records whose single-item Jobs carry them as `subjectKind`/`subjectId`. */
const jobSubjectEntity = z.enum(["image", "location"]);
export type JobSubjectEntity = z.infer<typeof jobSubjectEntity>;

const jobListInput = z.union([
  z.strictObject({ runId: runShortcode }),
  z.strictObject({
    subject: z.object({ kind: jobSubjectEntity, id: z.string().min(1) }),
  }),
]);

const jobListOut = z.object({
  /** The Job executing a Run (`run.execute`), or a subject's latest Job. */
  primary: jobFacts.nullable(),
  /** Every other Job kind for the owner, as counts. */
  groups: z.array(jobGroup),
  limits: z.array(limitEntry),
  binding: limitBinding,
  /** A Run owner's waiting-on rollup; null for a subject. */
  rollup: runRollup.nullable(),
});
export type JobListOut = z.infer<typeof jobListOut>;

export const JOB_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const jobLogLine = z.object({
  id: z.string(),
  timestamp: z.number(),
  /** Workers Logs' level (`log` reads as info). */
  level: z.string(),
  message: z.string(),
  /** The structured fields logged beside the message, credentials scrubbed. */
  fields: z.string().nullable(),
});
export type JobLogLine = z.infer<typeof jobLogLine>;

const logWindow = z.object({ from: z.number(), to: z.number() });

const jobLogsOut = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_configured"), dashboardUrl: z.url() }),
  z.object({
    status: z.literal("expired"),
    window: logWindow,
    dashboardUrl: z.url(),
  }),
  z.object({
    status: z.literal("error"),
    request: z.string(),
    message: z.string(),
    dashboardUrl: z.url(),
  }),
  z.object({
    status: z.literal("ok"),
    lines: z.array(jobLogLine),
    /** Matching events Workers Logs counted; may exceed the lines returned. */
    count: z.number().int().nonnegative(),
    window: logWindow,
    dashboardUrl: z.url(),
  }),
]);
export type JobLogsOut = z.infer<typeof jobLogsOut>;

export const jobContract = defineContract(
  "job",
  {
    list: query({
      exposure: "view",
      input: jobListInput,
      output: jobListOut,
      // Job state moves while a Run executes; Run writes refresh it.
      cache: { tags: [["run"]], profile: "live-status" },
    }),
    queue: query({
      description:
        "Live Jobs grouped by lane (apple_device, frontier_ai, server, external) and what they wait on (due, waiting_device, waiting_funding, leased, backing_off, blocked, paused, update_required), with one page of matching Jobs. Filter by lane, kind, reason, state, Run or attention.",
      input: z.strictObject({
        filter: jobSetFilter.default({}),
        pageIndex: z.int().nonnegative().default(0),
        pageSize: z.int().min(1).max(100).default(25),
      }),
      output: jobQueueOut,
      cache: { tags: [["run"]], profile: "live-status" },
    }),
    retryNow: mutation({
      description:
        "Retry now: make every Job in the filtered set due immediately, clearing backoff and provider waits. Failed and cancelled Jobs reopen with a fresh attempt budget; running and member-paused Jobs are left alone. Prior errors are kept.",
      input: z.strictObject({ filter: jobSetFilter }),
      output: z.object({ retried: z.number().int().nonnegative() }),
      invalidates: ["runOnly", "image"],
    }),
    explain: query({
      description:
        "Explain what a Run (RUN-), image job (IPR-), Email (EML-) or Job (uuid) is waiting on, as a chain from the record to the Jobs that block it.",
      input: z.strictObject({ id: explainTarget }),
      output: explainOut,
      cache: { tags: [["run"], ["image"]], profile: "live-status" },
    }),
    runRollups: query({
      exposure: "view",
      input: z.strictObject({
        runIds: z.array(runShortcode).min(1).max(100),
      }),
      output: z.object({ rollups: z.array(runRollup) }),
      cache: { tags: [["run"]], profile: "live-status" },
    }),
    health: query({
      description:
        "The queue watchdog's latest per-kind health (oldest due age, claims per minute, due growth, expired leases, image/Job disagreement) and the alerts it raised, with raw numbers.",
      input: z.strictObject({}),
      output: queueHealthSnapshot.nullable(),
      cache: { tags: [["run"]], profile: "live-status" },
    }),
    logs: query({
      note: "Raw Worker log lines for one Job; agents read Run state instead",
      description:
        "Read raw Worker log lines for one Job and a bounded time range. Use Run status for workflow progress; logs are lower-level diagnostics.",
      input: z.strictObject({ jobId: z.uuid() }),
      output: jobLogsOut,
      cache: { tags: [] },
    }),
  },
  { exposure: "capability", mcpToolGroup: "maintenance" },
);

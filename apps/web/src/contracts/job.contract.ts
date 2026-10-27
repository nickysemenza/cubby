import {
  runShortcode,
  jobShortcode,
  anyShortcodeSchema,
} from "@cubby/schemas/identifiers";
import {
  jobLane,
  jobState,
  jobWaitingOn,
  jobWaitingOnReason,
  jobWaitReason,
} from "@cubby/schemas/job";
import { jobFilters } from "@cubby/schemas/job-entity";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

/** One self-describing pattern retains legacy Job UUIDs alongside public codes. */
const explainPatterns = [
  anyShortcodeSchema(["run", "imageJob", "email", "job"]),
  z.uuid(),
].map((schema) => z.string().parse(z.toJSONSchema(schema).pattern));
const explainTarget = z
  .string()
  .regex(new RegExp(explainPatterns.join("|")))
  .describe(
    "A Run (RUN-), image job (IPR-), Email (EML-), Job (JOB-), or legacy Job UUID.",
  );

/** One Job as diagnostics read it: execution facts only, never domain state. */
const jobFacts = z.object({
  id: z.uuid(),
  key: z.string(),
  kind: z.string(),
  state: jobState,
  generation: z.number().int(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive().nullable(),
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
  /**
   * Live Jobs per waiting-on reason; terminal Jobs are not counted. `leased`
   * counts live leases only: an expired one is in `expiredLeases`.
   */
  counts: z.partialRecord(jobWaitingOnReason, z.number().int().nonnegative()),
  /** Running Jobs whose executor's lease lapsed; the next claim reclaims them. */
  expiredLeases: z.number().int().nonnegative(),
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
  codes: z.array(jobShortcode).min(1).optional(),
  entityFilters: jobFilters.optional(),
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

/**
 * Parked Apple-device work at a glance, for the "waiting for a device"
 * banner. `workingDevices` counts devices that claimed work in the last
 * ten minutes; `etaSeconds` is null when nothing waits or nothing claims.
 */
const deviceBacklog = z.object({
  waiting: z.number().int().nonnegative(),
  runsWaiting: z.number().int().nonnegative(),
  workingDevices: z.number().int().nonnegative(),
  claimsPerMinute: z.number().nonnegative(),
  etaSeconds: z.number().int().nonnegative().nullable(),
});
export type DeviceBacklog = z.infer<typeof deviceBacklog>;

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
export type WorkStream = z.infer<typeof workStream>;
const workActivity = z.object({
  measuredAt: z.iso.datetime(),
  windows: z.object({
    paceMinutes: z.number().int().positive(),
    completedMinutes: z.number().int().positive(),
    failedMinutes: z.number().int().positive(),
  }),
  streams: z.array(workStream),
});
export type WorkActivity = z.infer<typeof workActivity>;

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
        "Explain what a Run (RUN-), image job (IPR-), Email (EML-) or Job (JOB- or legacy uuid) is waiting on, as a chain from the record to the Jobs that block it.",
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
    deviceBacklog: query({
      description:
        "Apple-device image work waiting now: due Jobs, the Runs they hold up, devices that claimed work in the last 10 minutes, claims per minute and the ETA at that pace.",
      input: z.strictObject({}),
      output: deviceBacklog,
      cache: { tags: [["run"], ["image"]], profile: "live-status" },
    }),
    activity: query({
      description:
        "Live work by Job kind: running, due, backing off, scheduled and paused counts, completions per minute over the last 5 minutes, completions in 15 minutes, failures in 60 minutes, the last completion, the oldest due Job and the active Runs it serves. Internal maintenance kinds are omitted.",
      input: z.strictObject({}),
      output: workActivity,
      cache: { tags: [["run"]], profile: "live-status" },
    }),
    logs: query({
      note: "Raw Worker log lines for one Job; agents read Run state instead",
      description:
        "Read raw Worker log lines for one Job and a bounded time range. Use Run status for workflow progress; logs are lower-level diagnostics.",
      input: z.strictObject({ jobId: z.union([z.uuid(), jobShortcode]) }),
      output: jobLogsOut,
      cache: { tags: [] },
    }),
  },
  { exposure: "capability", mcpToolGroup: "maintenance" },
);

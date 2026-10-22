import { runShortcode } from "@cubby/schemas/identifiers";
import { jobState, jobWaitReason } from "@cubby/schemas/job";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

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
  /** Same-kind due Jobs the fair drain serves first; null when not due. */
  ahead: z.number().int().nonnegative().nullable(),
});
export type JobFacts = z.infer<typeof jobFacts>;

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

export const jobContract = defineContract("job", {
  list: query({
    mcp: { omit: "client_view" },
    input: jobListInput,
    output: jobListOut,
    // Job state moves while a Run executes; Run writes refresh it.
    cache: { tags: [["run"]], profile: "live-status" },
  }),
  logs: query({
    mcp: {
      omit: "operator_maintenance",
      note: "Raw Worker log lines for one Job; agents read Run state instead",
    },
    input: z.strictObject({ jobId: z.uuid() }),
    output: jobLogsOut,
    cache: { tags: [] },
  }),
});

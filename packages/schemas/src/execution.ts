import { z } from "zod";
import type { RunWaitingOn, RunWaitReason } from "./run-waiting-on";

const executionWaitReasons = [
  "provider_capacity",
  "ai_funding_window",
  "device",
  "rate_limit",
] as const;
export const executionWaitReason = z.enum(executionWaitReasons);
export type ExecutionWaitReason = z.infer<typeof executionWaitReason>;

/**
 * Why a derived value's stored refresh metadata reports an attempt-free wait.
 */
const workWaitCauses = ["search_coverage"] as const;
const workWaitCause = z.enum(workWaitCauses);
type WorkWaitCause = z.infer<typeof workWaitCause>;
const WORK_WAIT_CAUSE_TEXT = {
  search_coverage: "Waiting for search indexing",
} as const satisfies Record<WorkWaitCause, string>;

/** Who executes a work kind; every waiting-on explanation names its lane. */
const executionLane = z.enum([
  "apple_device",
  "frontier_ai",
  "server",
  "external",
]);

/**
 * What one live claim waits on, derived from its stored execution facts by
 * the image execution projection. Terminal claims wait on nothing (null).
 */
const workWaitingOn = z.discriminatedUnion("reason", [
  z.object({
    reason: z.literal("due"),
    lane: executionLane,
  }),
  z.object({
    reason: z.literal("waiting_device"),
    lane: executionLane,
  }),
  z.object({
    reason: z.literal("waiting_funding"),
    lane: executionLane,
    until: z.iso.datetime().nullable(),
  }),
  z.object({
    reason: z.literal("leased"),
    lane: executionLane,
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
    lane: executionLane,
    until: z.iso.datetime(),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    /** A stored provider wait (`rate_limit`, `provider_capacity`), or the next WorkItem's explicit wait, when one set the time. */
    cause: z.enum([...executionWaitReasons, ...workWaitCauses]).nullable(),
  }),
  z.object({
    reason: z.literal("blocked"),
    lane: executionLane,
    by: z.string(),
  }),
  z.object({
    reason: z.literal("paused"),
    lane: executionLane,
    by: z.enum(["member", "run"]),
  }),
  z.object({
    reason: z.literal("update_required"),
    lane: executionLane,
    device: z.string(),
  }),
]);
export type WorkWaitingOn = z.infer<typeof workWaitingOn>;
const workWaitingOnReason = z.enum([
  "due",
  "waiting_device",
  "waiting_funding",
  "leased",
  "backing_off",
  "blocked",
  "paused",
  "update_required",
] satisfies readonly WorkWaitingOn["reason"][]);
export type WorkWaitingOnReason = z.infer<typeof workWaitingOnReason>;

/** Failures after which never-exhausting work also shows as needing attention. */
export const WORK_NEEDS_ATTENTION_ATTEMPTS = 5;

const JOB_WAITING_ON_LABEL = {
  due: "Due",
  waiting_device: "Waiting for any Apple device",
  waiting_funding: "Waiting for AI funding",
  leased: "In progress",
  backing_off: "Backing off",
  blocked: "Blocked",
  paused: "Paused",
  update_required: "Update required",
} as const satisfies Record<WorkWaitingOnReason, string>;

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
 * One line naming what a claim waits on, for every text surface (generated
 * entity fields, Activity, explain). Raw errors stay in their own field.
 */
export function describeWorkWaitingOn(
  waitingOn: WorkWaitingOn | null,
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
 * A Run rollup's live claims as one line ("12 due · 3 in progress"), in the
 * fixed reason order; null when no live claim remains.
 */
function describeWorkRollup(
  counts: Partial<Record<WorkWaitingOnReason, number>>,
  /** Running claims whose lease lapsed; they are live but in no `counts` reason. */
  expiredLeases = 0,
): string | null {
  const parts = workWaitingOnReason.options.flatMap((reason) => {
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
const workQueueWaitReason = z.enum([...executionWaitReasons, "retry", "turn"]);
export { runWaitingOn, type RunWaitingOn } from "./run-waiting-on";
export type RunWaitGroup = {
  kind: string;
  reason: z.infer<typeof workQueueWaitReason>;
  /** This Run's claims in the group. */
  mine: number;
  /**
   * The Run's first due claim of the group in the kind's claim order across
   * every due claim of the kind (`dueUnits`), 1-based; null while none is due.
   */
  position: number | null;
  /** Due claims of the kind; null while none of the Run's is due. */
  total: number | null;
  /** The earliest `availableAt` among this Run's claims in the group. */
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

/** Fallback when no claim waits in a group (image rows, leases, pauses), by precedence. */
const COUNT_REASON: readonly [WorkWaitingOnReason, RunWaitReason][] = [
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

/** When `position` claims drain at `perMinute`; null without a pace. */
function queueEtaAt(
  position: number,
  perMinute: number | null,
  now: Date,
): Date | null {
  if (!perMinute || perMinute <= 0) return null;
  return new Date(now.getTime() + (position / perMinute) * 60_000);
}

/** "less than a minute", "about 16 min", "about 2 h", "about 3 d". */
function aboutSpanText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 90) return `about ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `about ${hours} h` : `about ${Math.round(hours / 24)} d`;
}

/** 1st, 2nd, 3rd, 4th, 11th, 22nd. */
function ordinalText(value: number): string {
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
 * claims, then live leases, then the remaining counts.
 */
export function summarizeRunWait(input: {
  now: Date;
  formatTime: (at: Date) => string;
  /** The Run itself is paused for the AI funding window. */
  waitingForFunding: boolean;
  /** When that window's resume is scheduled; null when none is queued. */
  fundingResumeAt: Date | null;
  groups: readonly RunWaitGroup[];
  /** Completions per minute by work kind over `paceMinutes`. */
  perMinute: ReadonlyMap<string, number>;
  paceMinutes: number;
  counts: Partial<Record<WorkWaitingOnReason, number>>;
  expiredLeases: number;
}): RunWaitingOn | null {
  const { now, paceMinutes } = input;
  const jobs = describeWorkRollup(input.counts, input.expiredLeases);
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
    // The kind drains its whole due queue at its pace, so a due claim's ETA is
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

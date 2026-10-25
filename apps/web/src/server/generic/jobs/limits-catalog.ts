import type { JobState, JobWaitReason } from "@cubby/schemas/job";
import type { RunStepPageSample } from "@cubby/schemas/run-step";
import { BACKGROUND_QUEUE_CONSUMER } from "@cubby/shared/background-queue";
import { JOB_PAGE_LIMITS } from "@cubby/shared/job-page-limits";

import type { LimitBinding, LimitEntry } from "~/contracts/job.contract";
import { formatInstant } from "~/lib/date-format";
import { formatDuration } from "~/lib/format-duration";
import { formatCount } from "~/lib/number-format";
import { AI_BUDGET_WINDOW_MS } from "~/server/ai/budget-window";
import { GATEWAY_EGRESS_LIMITS } from "~/server/ai/gateway-egress-contract";
import {
  DEFAULT_RATE_LIMIT_DELAY_MS,
  MAX_RATE_LIMIT_DELAY_MS,
} from "~/server/ai/gateway-error";
import { WORKER_REQUEST_CONNECTIONS } from "~/server/db/db-runtime-resolver";
import {
  TRANSFER_PAIR_GENERATION_BYTES,
  TRANSFER_PAIR_GENERATION_PAGE,
  TRANSFER_PAIR_PUBLICATION_CONCURRENCY,
  TRANSFER_PAIR_PUBLISH_CONCURRENCY,
} from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import { MAX_ACTIVE_AI_REFRESH_RUNS } from "~/server/domains/run/repo/ai-refresh-admission";
import { STATEMENT_SPENDING_PREPARATION_CONCURRENCY } from "~/server/domains/transaction-import/repo/statement-spending";
import { STATEMENT_PUBLISH_CONCURRENCY } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { JOB_DRAIN, JOB_HEARTBEAT_MS } from "~/server/generic/jobs/limits";
import {
  DEFAULT_JOB_MAX_ATTEMPTS,
  JOB_LEASE_MS,
  JOB_RETRY_BACKOFF,
} from "~/server/generic/jobs/repo/jobs";

/**
 * Every limit that can set a Run's speed, read from the constant or config
 * that enforces it. This module only reads them: changing a value happens at
 * its source. Step page caps name the RunStep keys whose pager applies them;
 * in-page concurrency caps also name the page phase they bound, which the
 * page sample's `concurrency` reports against.
 */
type CatalogEntry = Omit<LimitEntry, "utilization" | "phase"> & {
  stepKeys?: readonly string[];
  phase?: string;
};

const JOBS_REPO = "apps/web/src/server/generic/jobs/repo/jobs.ts";
const JOBS_LIMITS = "apps/web/src/server/generic/jobs/limits.ts";

export const LIMITS_CATALOG = [
  {
    key: "queue.concurrency",
    label: "Background queue consumers",
    scope: "queue",
    value: BACKGROUND_QUEUE_CONSUMER.maxConcurrency,
    unit: "drains at once",
    source:
      "apps/web/cloudflare.config.ts cubby-background maxConcurrency (packages/shared/src/background-queue-consumer.json)",
  },
  {
    key: "queue.batch",
    label: "Wake messages per delivery",
    scope: "queue",
    value: BACKGROUND_QUEUE_CONSUMER.maxBatchSize,
    unit: "messages",
    source:
      "apps/web/cloudflare.config.ts cubby-background maxBatchSize (packages/shared/src/background-queue-consumer.json)",
  },
  {
    key: "drain.pages",
    label: "Job pages per drain",
    scope: "drain",
    value: JOB_DRAIN.pageLimit,
    unit: "pages",
    source: `${JOBS_LIMITS} JOB_DRAIN.pageLimit`,
  },
  {
    key: "drain.time",
    label: "Drain time budget",
    scope: "drain",
    value: JOB_DRAIN.timeBudgetMs,
    unit: "ms",
    source: `${JOBS_LIMITS} JOB_DRAIN.timeBudgetMs`,
  },
  {
    key: "drain.batch",
    label: "Due Jobs per fair round",
    scope: "drain",
    value: JOB_DRAIN.batch,
    unit: "Jobs",
    source: `${JOBS_LIMITS} JOB_DRAIN.batch`,
  },
  {
    key: "drain.concurrency",
    label: "Pages each drain runs at once",
    scope: "drain",
    value: JOB_DRAIN.concurrency,
    unit: "pages",
    source: `${JOBS_LIMITS} JOB_DRAIN.concurrency`,
  },
  {
    key: "lease.duration",
    label: "Job lease",
    scope: "job lease",
    value: JOB_LEASE_MS,
    unit: "ms",
    source: `${JOBS_REPO} JOB_LEASE_MS`,
  },
  {
    key: "lease.heartbeat",
    label: "Lease heartbeat",
    scope: "job lease",
    value: JOB_HEARTBEAT_MS,
    unit: "ms",
    source: `${JOBS_LIMITS} JOB_HEARTBEAT_MS`,
  },
  {
    key: "job.attempts",
    label: "Attempts before a Job fails",
    scope: "job lease",
    value: DEFAULT_JOB_MAX_ATTEMPTS,
    unit: "attempts",
    source: `${JOBS_REPO} DEFAULT_JOB_MAX_ATTEMPTS (per Job: maxAttempts)`,
  },
  {
    key: "job.backoff",
    label: "Retry backoff ceiling",
    scope: "job lease",
    value: JOB_RETRY_BACKOFF.maxMs,
    unit: "ms",
    source: `${JOBS_REPO} JOB_RETRY_BACKOFF (from ${formatDuration(JOB_RETRY_BACKOFF.baseMs)}, doubling)`,
  },
  {
    key: "page.transfer_pairs",
    label: "Transfer pairs per page",
    scope: "step page",
    value: TRANSFER_PAIR_GENERATION_PAGE,
    unit: "pairs",
    source:
      "apps/web/src/server/domains/financial-transaction/repo/transfer-pair-suggestions.ts TRANSFER_PAIR_GENERATION_PAGE",
    stepKeys: ["transfer_pair_scan"],
  },
  {
    key: "page.transfer_bytes",
    label: "Transfer publication bytes per page",
    scope: "step page",
    value: TRANSFER_PAIR_GENERATION_BYTES,
    unit: "bytes",
    source:
      "apps/web/src/server/domains/financial-transaction/repo/transfer-pair-suggestions.ts TRANSFER_PAIR_GENERATION_BYTES",
    stepKeys: ["transfer_pair_scan"],
  },
  {
    key: "page.suggestions",
    label: "Suggestions per page",
    scope: "step page",
    value: JOB_PAGE_LIMITS.suggestionsPerPage,
    unit: "suggestions",
    source:
      "packages/shared/src/job-page-limits.ts JOB_PAGE_LIMITS.suggestionsPerPage",
  },
  {
    key: "page.decisions",
    label: "Decision questions per page",
    scope: "step page",
    value: JOB_PAGE_LIMITS.maxDecisionQuestionsPerPage,
    unit: "questions",
    source:
      "packages/shared/src/job-page-limits.ts JOB_PAGE_LIMITS.maxDecisionQuestionsPerPage",
  },
  {
    key: "page.transfer_publication",
    label: "Transfer pair publication concurrency",
    scope: "step page",
    value: TRANSFER_PAIR_PUBLICATION_CONCURRENCY,
    unit: "at once",
    source:
      "apps/web/src/server/domains/financial-transaction/repo/transfer-pair-suggestions.ts TRANSFER_PAIR_PUBLICATION_CONCURRENCY",
    stepKeys: ["transfer_pair_scan"],
    phase: "publication",
  },
  {
    key: "page.transfer_label_publication",
    label: "Transfer label publication concurrency",
    scope: "step page",
    value: TRANSFER_PAIR_PUBLISH_CONCURRENCY,
    unit: "at once",
    source:
      "apps/web/src/server/domains/financial-transaction/repo/transfer-pair-suggestions.ts TRANSFER_PAIR_PUBLISH_CONCURRENCY",
    stepKeys: ["transfer_pair_label"],
    phase: "publication",
  },
  {
    key: "page.statement_publication",
    label: "Statement suggestion publication concurrency",
    scope: "step page",
    value: STATEMENT_PUBLISH_CONCURRENCY,
    unit: "at once",
    source:
      "apps/web/src/server/domains/transaction-import/repo/statement-suggestions.ts STATEMENT_PUBLISH_CONCURRENCY",
    stepKeys: ["statement_generate"],
    phase: "publication",
  },
  {
    key: "page.statement_preparation",
    label: "Statement spending preparation concurrency",
    scope: "step page",
    value: STATEMENT_SPENDING_PREPARATION_CONCURRENCY,
    unit: "at once",
    source:
      "apps/web/src/server/domains/transaction-import/repo/statement-spending.ts STATEMENT_SPENDING_PREPARATION_CONCURRENCY",
    stepKeys: ["statement_generate"],
    phase: "preparation",
  },
  {
    key: "gateway.inflight",
    label: "AI Gateway requests in flight",
    scope: "AI gateway",
    value: GATEWAY_EGRESS_LIMITS.unifiedMaxInFlight,
    unit: "requests",
    source:
      "apps/web/src/server/ai/gateway-egress-contract.ts GATEWAY_EGRESS_LIMITS.unifiedMaxInFlight",
  },
  {
    key: "gateway.rate",
    label: "AI Gateway requests per window",
    scope: "AI gateway",
    value: GATEWAY_EGRESS_LIMITS.requestsPerWindow,
    unit: `per ${formatDuration(GATEWAY_EGRESS_LIMITS.windowMs)}`,
    source:
      "apps/web/src/server/ai/gateway-egress-contract.ts GATEWAY_EGRESS_LIMITS.requestsPerWindow",
  },
  {
    key: "gateway.deadline",
    label: "AI request deadline",
    scope: "AI gateway",
    value: GATEWAY_EGRESS_LIMITS.requestDeadlineMs,
    unit: "ms",
    source:
      "apps/web/src/server/ai/gateway-egress-contract.ts GATEWAY_EGRESS_LIMITS.requestDeadlineMs",
  },
  {
    key: "ai_refresh.slots",
    label: "Active AI refresh Runs",
    scope: "AI gateway",
    value: MAX_ACTIVE_AI_REFRESH_RUNS,
    unit: "Runs",
    source:
      "apps/web/src/server/domains/run/repo/ai-refresh-admission.ts MAX_ACTIVE_AI_REFRESH_RUNS",
  },
  {
    key: "funding.window",
    label: "AI funding window",
    scope: "funding",
    value: AI_BUDGET_WINDOW_MS,
    unit: "ms",
    source: "apps/web/src/server/ai/budget-window.ts AI_BUDGET_WINDOW_MS",
  },
  {
    key: "provider.retry_after",
    label: "Provider rate-limit wait",
    scope: "provider",
    value: DEFAULT_RATE_LIMIT_DELAY_MS,
    unit: "ms",
    source: `apps/web/src/server/ai/gateway-error.ts DEFAULT_RATE_LIMIT_DELAY_MS (Retry-After wins, capped at ${formatDuration(MAX_RATE_LIMIT_DELAY_MS)})`,
  },
  {
    key: "db.connections",
    label: "Database connections per request",
    scope: "database",
    value:
      WORKER_REQUEST_CONNECTIONS.strong +
      WORKER_REQUEST_CONNECTIONS["bounded-stale"],
    unit: "sockets",
    source:
      "apps/web/src/server/db/db-runtime-resolver.ts WORKER_REQUEST_CONNECTIONS",
  },
] as const satisfies readonly CatalogEntry[];

type LimitKey = (typeof LIMITS_CATALOG)[number]["key"];

const entry = (key: LimitKey) =>
  // SAFETY: `LimitKey` is derived from the catalog literal, so the key exists.
  LIMITS_CATALOG.find((limit) => limit.key === key)!;

/** The state the binding evaluation reads; every field comes from stored rows. */
export type BindingInput = {
  job: {
    kind: string;
    state: JobState;
    waitReason: JobWaitReason | null;
    waitUntil: Date | null;
    availableAt: Date;
    attempts: number;
    maxAttempts: number;
    /** Due Jobs the fair drain serves first; null when the Job is not due. */
    ahead: number | null;
  } | null;
  /** Jobs of every kind holding a live lease now. */
  runningJobs: number;
  /** The Run's current step, its last page's wall time and work sample. */
  step: {
    key: string;
    lastPageMs: number | null;
    page: RunStepPageSample | null;
  } | null;
  now: Date;
};

const at = (date: Date) => formatInstant(date, "dateShortTime");
/** Pages all consumers can run at once. */
const PAGE_SLOTS =
  BACKGROUND_QUEUE_CONSUMER.maxConcurrency * JOB_DRAIN.concurrency;
const consumers = (running: number) =>
  `${formatCount(Math.min(running, PAGE_SLOTS))} of ${formatCount(PAGE_SLOTS)} drain pages busy`;

const binding = (key: LimitKey, evidence: string): LimitBinding => ({
  status: "binding",
  key,
  label: entry(key).label,
  evidence,
});

const WAIT_LIMIT = {
  provider_capacity: "gateway.inflight",
  ai_funding_window: "funding.window",
  rate_limit: "provider.retry_after",
} as const satisfies Partial<Record<JobWaitReason, LimitKey>>;

/**
 * Which limit sets the Run's speed now. A typed Job wait names its limit;
 * a due Job behind others is held by drain capacity. Running pages report
 * measured work: a full concurrency peak or elapsed drain budget alone does
 * not prove what made a page slow. The drain yields only between pages.
 */
export function evaluateBinding(input: BindingInput): LimitBinding {
  const { job } = input;
  if (!job)
    return { status: "unknown", reason: "No Job is recorded for this Run." };
  if (job.state === "completed" || job.state === "cancelled")
    return { status: "none", reason: "The Job has finished." };
  if (job.state === "failed")
    return { status: "none", reason: "The Job failed; nothing is running." };
  if (job.state === "paused")
    return {
      status: "none",
      reason: "Paused; no limit applies until it resumes.",
    };
  if (job.waitReason === "device")
    return {
      status: "binding",
      key: null,
      label: "Device availability",
      evidence: job.waitUntil
        ? `Waiting for a device until ${at(job.waitUntil)}`
        : "Waiting for a device to take the work",
    };
  if (job.waitReason) {
    const until = job.waitUntil ? ` until ${at(job.waitUntil)}` : "";
    return binding(
      WAIT_LIMIT[job.waitReason],
      {
        provider_capacity: `Deferred for AI capacity${until}`,
        ai_funding_window: `Deferred for the AI funding window${until}`,
        rate_limit: `Provider asked to wait${until}`,
      }[job.waitReason],
    );
  }
  if (job.state === "retry_wait")
    return binding(
      "job.backoff",
      `Attempt ${formatCount(job.attempts)} of ${formatCount(job.maxAttempts)} failed; next try at ${at(job.availableAt)}`,
    );
  if (job.state === "queued") {
    if (job.availableAt > input.now)
      return {
        status: "none",
        reason: `Scheduled for ${at(job.availableAt)}.`,
      };
    const ahead =
      job.ahead === null
        ? null
        : `${formatCount(job.ahead)} ${job.ahead === 1 ? "Job" : "Jobs"} ahead`;
    if (input.runningJobs >= PAGE_SLOTS)
      return binding(
        "queue.concurrency",
        [consumers(input.runningJobs), ahead].filter(Boolean).join("; "),
      );
    return binding(
      "drain.batch",
      [consumers(input.runningJobs), ahead ?? "due now"].join("; "),
    );
  }
  // Running: only page samples say what is cutting it.
  const step = input.step;
  const lastPageMs = step?.lastPageMs ?? null;
  if (!step || (lastPageMs === null && !step.page))
    return { status: "unknown", reason: "Unknown — no recent samples." };
  // The drain checks its budget between pages, never interrupts a page.
  // Peak concurrency is an observed maximum, not evidence of contention.
  const work = step.page ? pageWork(step.page, lastPageMs) : null;
  if (work) return work;
  return {
    status: "unknown",
    reason:
      lastPageMs === null
        ? "Unknown — no recent samples."
        : `Last page took ${formatDuration(lastPageMs)}; phase timings were not recorded. The ${formatDuration(JOB_DRAIN.timeBudgetMs)} drain budget yields between pages and does not interrupt a page.`,
  };
}

const stepLimits = (stepKey: string) =>
  LIMITS_CATALOG.filter(
    (limit) =>
      "stepKeys" in limit &&
      // SAFETY: every catalog `stepKeys` is a string tuple; widening drops only the literal keys.
      (limit.stepKeys as readonly string[]).includes(stepKey),
  );

/**
 * "Page work: preparation 61% of page time · 106 queries/page": the phase
 * that took the largest share of the last page, measured, never inferred.
 */
function pageWork(
  page: RunStepPageSample,
  lastPageMs: number | null,
): LimitBinding | null {
  const phases = Object.entries(page.timings);
  const measured = phases.reduce((sum, [, ms]) => sum + ms, 0);
  const total = Math.max(measured, lastPageMs ?? 0);
  const [phase, ms] = [...phases].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (phase === undefined || ms === undefined || total <= 0) return null;
  return {
    status: "binding",
    key: null,
    label: "Page work",
    evidence: [
      `${phase} ${Math.round((ms / total) * 100)}% of page time`,
      page.queries === null
        ? "queries not measured"
        : `${formatCount(page.queries)} queries/page`,
    ].join(" · "),
  };
}

/** The catalog with live use where stored state shows it. */
export function limitEntries(use: {
  runningJobs: number;
  activeAiRefreshRuns: number;
  job: { attempts: number; maxAttempts: number } | null;
  step: BindingInput["step"];
}): LimitEntry[] {
  const current = use.step ? new Set(stepLimits(use.step.key)) : new Set();
  return LIMITS_CATALOG.map((limit) => {
    const { key, label, scope, value, unit, source } = limit;
    const phase = "phase" in limit ? limit.phase : null;
    const busy =
      phase && current.has(limit)
        ? use.step?.page?.concurrency?.[phase]
        : undefined;
    return {
      key,
      label,
      scope,
      value,
      unit,
      source,
      phase,
      utilization:
        busy !== undefined
          ? `${formatCount(busy)} of ${formatCount(value)} busy on the last page`
          : key === "queue.concurrency"
            ? `${formatCount(use.runningJobs)} Jobs running`
            : key === "ai_refresh.slots"
              ? `${formatCount(use.activeAiRefreshRuns)} of ${formatCount(value)} active`
              : key === "job.attempts" && use.job
                ? `Attempt ${formatCount(use.job.attempts)} of ${formatCount(use.job.maxAttempts)}`
                : null,
    };
  });
}

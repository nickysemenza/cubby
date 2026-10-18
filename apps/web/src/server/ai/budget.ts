import type { RunId } from "@cubby/schemas/identifiers";
import {
  aiBudgetSettings,
  type AiBudgetSettings,
  type AiBudgetStatus,
  type AiFundingStatus,
  type ChatGptPlanAvailability,
} from "@cubby/schemas/mail-import-settings";
import { supportedChatModelSchema } from "@cubby/shared/ai/models";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";

import { roundTo } from "~/lib/round-to";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiUsage, appSettings, run } from "~/server/db/schema";

import { chatGptPlanConnection } from "./chatgpt/client";

/**
 * Household caps on frontier chat-model spend per fixed six-hour UTC window
 * (ADR 0017): the paid budget sums charged cost, and the Claude credit budget
 * sums the standard API cost of subscriber-credit calls, which charge $0.
 * Embeddings, closed-set decision models and other model roles are not
 * budgeted. Admission (`paidRunPreflight`, `withAiBudget`,
 * `withCreditBudget`) and accounting (`readAiBudget`) share `aiBudgetCovers`.
 */
export const AI_BUDGET_LIMIT_USD = 1;
export const DEFAULT_CREDIT_BUDGET_USD = 5;
const WINDOW_MS = 6 * 60 * 60 * 1000;
const SETTINGS_ID = "00000000-0000-4000-8000-000000000077";
const FRONTIER_MODELS: readonly string[] = supportedChatModelSchema.options;
export const aiBudgetCovers = (model: string) =>
  FRONTIER_MODELS.includes(model);

const usd = (value: number) => `$${roundTo(value, 4)}`;

export class AiBudgetExhaustedError extends Error {
  constructor(
    readonly status: AiBudgetStatus,
    message = `AI budget reached: ${usd(status.paid.spentUsd)} of $${status.paid.limitUsd} paid since ${status.windowStart}; paid work resumes at ${status.windowEnd}.`,
    /** When the stopped work should try again. */
    readonly resumeAt = status.windowEnd,
  ) {
    super(message);
    this.name = "AiBudgetExhaustedError";
  }
}

/**
 * Background work reached the paid rung: it waits for free capacity instead
 * of paying. A budget pause to every recovery path that handles one.
 */
export class AiFundingWaitError extends AiBudgetExhaustedError {
  constructor(status: AiBudgetStatus, message: string, resumeAt: string) {
    super(status, message, resumeAt);
    this.name = "AiFundingWaitError";
  }
}

export function aiBudgetWindow(now = new Date()) {
  const start = Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS;
  return { start: new Date(start), end: new Date(start + WINDOW_MS) };
}

async function readAiBudgetSettings(db: Database): Promise<AiBudgetSettings> {
  const [row] = await getDb(db)
    .select({ metadata: appSettings.metadata })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ID));
  return row
    ? aiBudgetSettings.parse(row.metadata)
    : { creditLimitUsd: DEFAULT_CREDIT_BUDGET_USD };
}

export async function setCreditBudget(
  db: Database,
  creditLimitUsd: number,
): Promise<AiBudgetSettings> {
  const metadata = aiBudgetSettings.parse({ creditLimitUsd });
  await getDb(db)
    .insert(appSettings)
    .values({ id: SETTINGS_ID, metadata })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { metadata, updatedAt: new Date() },
    });
  return metadata;
}

const creditRow = sql`${aiUsage.costEvidence}->>'billingReason' = 'subscriber_credit'`;

/**
 * Spend reads the `AiUsage` ledger, which the telemetry queue writes after
 * each call, so both are soft limits: calls already in flight can overshoot a
 * window by their own cost.
 */
export async function readAiBudget(
  db: Database,
  now = new Date(),
): Promise<AiBudgetStatus> {
  const window = aiBudgetWindow(now);
  const [[row], settings] = await Promise.all([
    getDb(db)
      .select({
        credit: sql<number>`COALESCE(sum(${aiUsage.standardCost}) FILTER (WHERE ${creditRow}), 0)::double precision`,
        paid: sql<number>`COALESCE(sum(COALESCE(${aiUsage.chargedCost}, ${aiUsage.standardCost}, 0)) FILTER (WHERE (${creditRow}) IS NOT TRUE), 0)::double precision`,
      })
      .from(aiUsage)
      .where(
        and(
          gte(aiUsage.createdAt, window.start),
          isNull(aiUsage.deletedAt),
          inArray(aiUsage.model, [...FRONTIER_MODELS]),
        ),
      ),
    readAiBudgetSettings(db),
  ]);
  return {
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    credit: {
      limitUsd: settings.creditLimitUsd,
      spentUsd: Math.max(0, row?.credit ?? 0),
    },
    paid: {
      limitUsd: AI_BUDGET_LIMIT_USD,
      spentUsd: Math.max(0, row?.paid ?? 0),
    },
  };
}

/** `allowanceUsd`: a member's confirmed spend past the paid limit. */
export async function assertAiBudget(db: Database, allowanceUsd = 0) {
  const status = await readAiBudget(db);
  if (status.paid.spentUsd >= status.paid.limitUsd + allowanceUsd)
    throw new AiBudgetExhaustedError(status);
}

/** The refusal a background credit call receives once the credit window is spent. */
export async function creditBudgetRefusal(
  db: Database,
): Promise<string | null> {
  const { credit, windowStart, windowEnd } = await readAiBudget(db);
  return credit.spentUsd >= credit.limitUsd
    ? `Claude credit budget reached: ${usd(credit.spentUsd)} of $${credit.limitUsd} standard cost since ${windowStart}; credit resumes at ${windowEnd}.`
    : null;
}

const RECENT_MS = WINDOW_MS;
// The plan codes `isInferenceFundingRefusal` treats as exhausted quota.
const PLAN_QUOTA =
  /usage_limit_reached|rate_limit_exceeded|subscription_sharing_usage_limit_exceeded/u;

/** A plan quota refusal's reset: its hint when present, else the next window. */
function planResetAt(failure: string, refusedAt: Date): Date {
  const absolute = /"resets_at"\s*:\s*(\d{9,})/u.exec(failure);
  if (absolute) return new Date(Number(absolute[1]) * 1000);
  const relative = /"resets_in_seconds"\s*:\s*(\d+)/u.exec(failure);
  if (relative)
    return new Date(refusedAt.getTime() + Number(relative[1]) * 1000);
  return aiBudgetWindow(refusedAt).end;
}

export interface FundingStatusPorts {
  now?: Date;
  /** The household plan connection; null where no plan storage exists. */
  planConnection?: () => Promise<{
    connected: boolean;
    needsReauthorization: boolean;
  } | null>;
}

export async function readChatGptPlanAvailability(
  db: Database,
  {
    now = new Date(),
    planConnection = chatGptPlanConnection,
  }: FundingStatusPorts = {},
): Promise<ChatGptPlanAvailability> {
  const connection = await planConnection();
  if (!connection?.connected)
    return {
      state: "disconnected",
      until: null,
      reason: connection
        ? "The household ChatGPT plan is not connected."
        : "ChatGPT plan storage is unavailable in this runtime.",
    };
  if (connection.needsReauthorization)
    return {
      state: "needs_reauthorization",
      until: null,
      reason: "The household ChatGPT plan needs reauthorization.",
    };
  const [latest] = await getDb(db)
    .select({ createdAt: aiUsage.createdAt, failure: aiUsage.failure })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.transport, "chatgpt"),
        gte(aiUsage.createdAt, new Date(now.getTime() - RECENT_MS)),
        isNull(aiUsage.deletedAt),
      ),
    )
    .orderBy(desc(aiUsage.createdAt))
    .limit(1);
  const until =
    latest?.failure && PLAN_QUOTA.test(latest.failure)
      ? planResetAt(latest.failure, latest.createdAt)
      : null;
  return until && until > now
    ? {
        state: "paused",
        until: until.toISOString(),
        reason: latest?.failure ?? null,
      }
    : { state: "available", until: null, reason: null };
}

export async function readAiFundingStatus(
  db: Database,
  ports: FundingStatusPorts = {},
): Promise<AiFundingStatus> {
  const [budget, plan] = await Promise.all([
    readAiBudget(db, ports.now),
    readChatGptPlanAvailability(db, ports),
  ]);
  return { ...budget, plan };
}

async function latestCreditRefusal(db: Database, now: Date) {
  const [row] = await getDb(db)
    .select({ failure: aiUsage.failure })
    .from(aiUsage)
    .where(
      and(
        creditRow,
        isNotNull(aiUsage.failure),
        gte(aiUsage.createdAt, new Date(now.getTime() - RECENT_MS)),
        isNull(aiUsage.deletedAt),
      ),
    )
    .orderBy(desc(aiUsage.createdAt))
    .limit(1);
  return row?.failure ?? null;
}

/**
 * Background work at the paid rung: both free rungs refused. It waits while a
 * free rung can return within six hours (the credit window resets by
 * construction; a plan quota resets at its hint or is assumed to by the next
 * window). Without one — the Console refused the credit and the plan is
 * disconnected — it still never pays automatically; the reason says so.
 */
export async function fundingWaitError(
  db: Database,
  ports: FundingStatusPorts = {},
): Promise<AiFundingWaitError> {
  const now = ports.now ?? new Date();
  const [status, creditRefusal] = await Promise.all([
    readAiFundingStatus(db, { ...ports, now }),
    latestCreditRefusal(db, now),
  ]);
  const { credit, plan, windowEnd } = status;
  const creditWindowSpent = credit.spentUsd >= credit.limitUsd;
  const creditText = creditWindowSpent
    ? `Claude credit budget used: ${usd(credit.spentUsd)} of $${credit.limitUsd} this window (resets ${windowEnd})`
    : `Claude credit refused by Anthropic${creditRefusal ? `: ${creditRefusal}` : ""}`;
  const planReturns =
    plan.state === "paused"
      ? plan.until
      : plan.state === "available"
        ? windowEnd
        : null;
  const planText =
    plan.state === "paused"
      ? `ChatGPT plan quota refused until ${plan.until}: ${plan.reason}`
      : plan.state === "available"
        ? `ChatGPT plan refused this request; assumed back by ${windowEnd}`
        : `ChatGPT plan unavailable (${plan.state}): ${plan.reason}`;
  const returns = [creditWindowSpent ? windowEnd : null, planReturns]
    .filter((at): at is string => at !== null)
    .sort();
  const resumeAt = returns[0] ?? windowEnd;
  return new AiFundingWaitError(
    status,
    returns.length
      ? `Waiting for free AI capacity; background work never pays. ${creditText}. ${planText}. Resumes at ${resumeAt}; "Run now, paid allowed" spends from the paid budget instead.`
      : `No free AI capacity can return within six hours, and background work never pays. ${creditText}. ${planText}. Reconnect the ChatGPT plan or raise the Console limit, or use "Run now, paid allowed"; rechecks at ${windowEnd}.`,
    resumeAt,
  );
}

const BACKGROUND_TRIGGERS: readonly string[] = [
  "scheduled",
  "discovery",
  "backfill",
];
const MAX_LINEAGE = 50;

/**
 * Background work: a Run whose lineage root nobody started (scheduled,
 * discovered or backfilled). Retries inherit their root's origin, as
 * `selectedCoordinatorExecution` does for member-selected Email Runs.
 */
export async function isBackgroundRun(
  db: Database,
  runId: RunId,
): Promise<boolean> {
  let current = runId;
  const visited = new Set<RunId>();
  for (let depth = 0; depth < MAX_LINEAGE; depth++) {
    visited.add(current);
    const [row] = await getDb(db)
      .select({ trigger: run.trigger, predecessorRunId: run.predecessorRunId })
      .from(run)
      .where(eq(run.id, current))
      .limit(1);
    if (!row) return false;
    if (!row.predecessorRunId || visited.has(row.predecessorRunId))
      return BACKGROUND_TRIGGERS.includes(row.trigger);
    current = row.predecessorRunId;
  }
  return false;
}

/**
 * Paid admission for a frontier call that has no Run-bound preflight.
 * Background work waits instead of paying; other work spends within the paid
 * budget. A supplied preflight owns the check itself (`paidRunPreflight`), so
 * it can pause its Run.
 */
export function withAiBudget<R>(
  db: Database | undefined,
  call: { model: string; runId?: RunId },
  preflight: ((request: R) => Promise<void>) | undefined,
): ((request: R) => Promise<void>) | undefined {
  if (preflight || !db || !aiBudgetCovers(call.model)) return preflight;
  return async () => {
    if (call.runId && (await isBackgroundRun(db, call.runId)))
      throw await fundingWaitError(db);
    await assertAiBudget(db);
  };
}

/** Credit-rung admission: background work stops drawing credit once its window budget is spent. */
export function withCreditBudget<R>(
  db: Database | undefined,
  call: { model: string; runId?: RunId },
  preflight: ((request: R) => Promise<string | null>) | undefined,
): ((request: R) => Promise<string | null>) | undefined {
  if (preflight || !db || !call.runId || !aiBudgetCovers(call.model))
    return preflight;
  const runId = call.runId;
  return async () =>
    (await isBackgroundRun(db, runId)) ? creditBudgetRefusal(db) : null;
}

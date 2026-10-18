import type { RunId } from "@cubby/schemas/identifiers";
import type {
  AiFundingStatus,
  ChatGptPlanAvailability,
} from "@cubby/schemas/mail-import-settings";
import { and, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiUsage, run } from "~/server/db/schema";
import { readPaidGrant } from "~/server/domains/run/repo/paid-grant";

import {
  AI_BUDGET_WINDOW_MS,
  AiFundingWaitError,
  aiBudgetWindow,
  budgetUsd,
  creditUsageRow,
  readAiBudget,
} from "./budget";

/*
 * What decides whether background work waits (ADR 0017): Run origin, the
 * credit window and the ChatGPT plan. Loaded on use by `budget.ts`
 * admissions, so the request-path bundle carries only the budget reads.
 */

/** The refusal a background credit call receives once the credit window is spent. */
export async function creditBudgetRefusal(
  db: Database,
): Promise<string | null> {
  const { credit, windowStart, windowEnd } = await readAiBudget(db);
  return credit.spentUsd >= credit.limitUsd
    ? `Claude credit budget reached: ${budgetUsd(credit.spentUsd)} of $${credit.limitUsd} standard cost since ${windowStart}; credit resumes at ${windowEnd}.`
    : null;
}

const RECENT_MS = AI_BUDGET_WINDOW_MS;
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
    // Loaded on use: the plan client stays out of the request-path bundle.
    planConnection = async () =>
      (await import("./chatgpt/client")).chatGptPlanConnection(),
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
        creditUsageRow,
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
    ? `Claude credit budget used: ${budgetUsd(credit.spentUsd)} of $${credit.limitUsd} this window (resets ${windowEnd})`
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
 * Automatic feature Runs retain purpose background even with the default
 * ephemeral trigger. Other background roots are scheduled, discovered or
 * backfilled. Retries inherit their root's origin, as
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
      .select({
        purpose: run.purpose,
        trigger: run.trigger,
        predecessorRunId: run.predecessorRunId,
      })
      .from(run)
      .where(eq(run.id, current))
      .limit(1);
    if (!row) return false;
    if (!row.predecessorRunId || visited.has(row.predecessorRunId))
      return (
        row.purpose === "background" ||
        BACKGROUND_TRIGGERS.includes(row.trigger)
      );
    current = row.predecessorRunId;
  }
  return false;
}

/** A grant allows paid fallback; its confirmed excess lapses with its window. */
export async function readPaidAllowance(db: Database, runId: RunId) {
  const grant = await readPaidGrant(db, runId);
  if (!grant) return null;
  return aiBudgetWindow(grant.createdAt).start.getTime() ===
    aiBudgetWindow().start.getTime()
    ? (grant.paidOverBudgetUsd ?? 0)
    : 0;
}

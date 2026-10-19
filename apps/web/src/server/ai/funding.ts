import type { RunId } from "@cubby/schemas/identifiers";
import type {
  AiFundingStatus,
  ChatGptPlanAvailability,
} from "@cubby/schemas/mail-import-settings";
import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";
import { and, desc, eq, gte, isNull } from "drizzle-orm";

import { getAiGatewayEgress } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiUsage, run } from "~/server/db/schema";
import { readPaidGrant } from "~/server/domains/run/repo/paid-grant";

import { budgetUsd, readAiBudget } from "./budget";
import { AI_BUDGET_WINDOW_MS, aiBudgetWindow } from "./budget-window";
import type { CreditRefusal } from "./gateway-egress-contract";

/*
 * What decides how background work is funded (ADR 0017): Run origin and the
 * credit and plan windows. Loaded on use by `budget.ts` admissions, so the
 * request-path bundle carries only the budget reads.
 */

/** The refusal a background free-rung call receives once its window budget is spent. */
export async function freeBudgetRefusal(
  db: Database,
  funding: "subscriber_credit" | "subscription",
): Promise<string | null> {
  const status = await readAiBudget(db);
  const [name, use] =
    funding === "subscriber_credit"
      ? ["Claude credit", status.credit]
      : ["ChatGPT plan", status.plan];
  return use.spentUsd >= use.limitUsd
    ? `${name} budget reached: ${budgetUsd(use.spentUsd)} of $${use.limitUsd} standard cost since ${status.windowStart}; it resumes at ${status.windowEnd}.`
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
  /** The egress Durable Object's recorded credit refusal; null without one. */
  creditRefusal?: () => Promise<CreditRefusal | null>;
}

/** The household's one egress object holds the credit refusal (ADR 0017). */
const egress = () => getAiGatewayEgress(CUBBY_AI_GATEWAY_ID);

/** "Retry Claude credit now", and every credit budget change. */
export async function resetCreditRefusal() {
  await egress()?.resetCreditRefusal();
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
  const {
    creditRefusal = async () => (await egress()?.creditRefusal()) ?? null,
  } = ports;
  const [budget, plan, refusal] = await Promise.all([
    readAiBudget(db, ports.now),
    readChatGptPlanAvailability(db, ports),
    creditRefusal(),
  ]);
  return {
    ...budget,
    credit: {
      ...budget.credit,
      ...(refusal
        ? {
            state: "refused" as const,
            until: new Date(refusal.until).toISOString(),
            reason: refusal.reason,
          }
        : { state: "available" as const, until: null, reason: null }),
    },
    plan: { ...budget.plan, ...plan },
  };
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

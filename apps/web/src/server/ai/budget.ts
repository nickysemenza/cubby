import type { AiBudgetStatus } from "@cubby/schemas/mail-import-settings";
import { and, gte, isNull, notInArray, sql } from "drizzle-orm";

import { roundTo } from "~/lib/round-to";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiUsage } from "~/server/db/schema";

import {
  MAILBOX_RELEVANCE_FEATURE,
  MAILBOX_TRIAGE_FEATURE,
} from "./policy/features";

/** Household allowance for metered AI: $1 per fixed six-hour UTC window. */
export const AI_BUDGET_LIMIT_USD = 1;
const WINDOW_MS = 6 * 60 * 60 * 1000;

/** Classification never waits on the allowance and never counts against it. */
const EXEMPT_FEATURES: readonly string[] = [
  MAILBOX_TRIAGE_FEATURE.feature,
  MAILBOX_RELEVANCE_FEATURE.feature,
];
const aiBudgetExempt = (feature: string) => EXEMPT_FEATURES.includes(feature);

export class AiBudgetExhaustedError extends Error {
  constructor(readonly status: AiBudgetStatus) {
    super(
      `AI budget reached: $${roundTo(status.spentUsd, 4)} of $${status.limitUsd} spent since ${status.windowStart}; paid work resumes at ${status.windowEnd}.`,
    );
    this.name = "AiBudgetExhaustedError";
  }
}

export function aiBudgetWindow(now = new Date()) {
  const start = Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS;
  return { start: new Date(start), end: new Date(start + WINDOW_MS) };
}

/**
 * Spend reads the `AiUsage` ledger, which the telemetry queue writes after
 * each call, so this is a soft limit: calls already in flight can overshoot a
 * window by their own cost.
 */
export async function readAiBudget(
  db: Database,
  now = new Date(),
): Promise<AiBudgetStatus> {
  const window = aiBudgetWindow(now);
  const [row] = await getDb(db)
    .select({
      spent: sql<number>`COALESCE(sum(COALESCE(${aiUsage.chargedCost}, ${aiUsage.standardCost}, 0)), 0)::double precision`,
    })
    .from(aiUsage)
    .where(
      and(
        gte(aiUsage.createdAt, window.start),
        isNull(aiUsage.deletedAt),
        notInArray(aiUsage.feature, [...EXEMPT_FEATURES]),
      ),
    );
  return {
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    limitUsd: AI_BUDGET_LIMIT_USD,
    spentUsd: Math.max(0, row?.spent ?? 0),
  };
}

export async function assertAiBudget(db: Database, feature: string) {
  if (aiBudgetExempt(feature)) return;
  const status = await readAiBudget(db);
  if (status.spentUsd >= status.limitUsd)
    throw new AiBudgetExhaustedError(status);
}

/**
 * Adds the budget check to a call that has no Run-bound preflight. A supplied
 * preflight owns the check itself (`paidRunPreflight`), so it can pause its Run.
 */
export function withAiBudget<R>(
  db: Database | undefined,
  feature: string,
  preflight: ((request: R) => Promise<void>) | undefined,
): ((request: R) => Promise<void>) | undefined {
  if (preflight || !db || aiBudgetExempt(feature)) return preflight;
  return () => assertAiBudget(db, feature);
}

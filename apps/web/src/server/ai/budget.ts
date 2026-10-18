import type { RunId } from "@cubby/schemas/identifiers";
import {
  aiBudgetSettings,
  type AiBudgetSettings,
  type AiBudgetStatus,
} from "@cubby/schemas/mail-import-settings";
import { supportedChatModelSchema } from "@cubby/shared/ai/models";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { roundTo } from "~/lib/round-to";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiUsage, appSettings } from "~/server/db/schema";

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
export const AI_BUDGET_WINDOW_MS = 6 * 60 * 60 * 1000;
const SETTINGS_ID = "00000000-0000-4000-8000-000000000077";
const FRONTIER_MODELS: readonly string[] = supportedChatModelSchema.options;
export const aiBudgetCovers = (model: string) =>
  FRONTIER_MODELS.includes(model);

export const budgetUsd = (value: number) => `$${roundTo(value, 4)}`;

export class AiBudgetExhaustedError extends Error {
  constructor(
    readonly status: AiBudgetStatus,
    message = `AI budget reached: ${budgetUsd(status.paid.spentUsd)} of $${status.paid.limitUsd} paid since ${status.windowStart}; paid work resumes at ${status.windowEnd}.`,
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
  const start =
    Math.floor(now.getTime() / AI_BUDGET_WINDOW_MS) * AI_BUDGET_WINDOW_MS;
  return { start: new Date(start), end: new Date(start + AI_BUDGET_WINDOW_MS) };
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

export const creditUsageRow = sql`${aiUsage.costEvidence}->>'billingReason' = 'subscriber_credit'`;

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
        credit: sql<number>`COALESCE(sum(${aiUsage.standardCost}) FILTER (WHERE ${creditUsageRow}), 0)::double precision`,
        paid: sql<number>`COALESCE(sum(COALESCE(${aiUsage.chargedCost}, ${aiUsage.standardCost}, 0)) FILTER (WHERE (${creditUsageRow}) IS NOT TRUE), 0)::double precision`,
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
    let allowanceUsd = 0;
    if (call.runId) {
      const funding = await import("./funding");
      const allowance = await funding.readPaidAllowance(db, call.runId);
      if (allowance === null && (await funding.isBackgroundRun(db, call.runId)))
        throw await funding.fundingWaitError(db);
      allowanceUsd = allowance ?? 0;
    }
    await assertAiBudget(db, allowanceUsd);
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
  return async () => {
    const funding = await import("./funding");
    return (await funding.isBackgroundRun(db, runId))
      ? funding.creditBudgetRefusal(db)
      : null;
  };
}

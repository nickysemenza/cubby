import { executionWaitReason } from "@cubby/schemas/execution";
import type { RunId } from "@cubby/schemas/identifiers";
import {
  aiBudgetSettings,
  type AiBudgetSettings,
  type AiBudgetStatus,
  storedAiBudgetSettings,
} from "@cubby/schemas/mail-import-settings";
import { paidFundingRefusal } from "@cubby/shared/ai/funding-refusal";
import { AI_MODELS } from "@cubby/shared/ai/models";
import { and, gte, inArray, sql } from "drizzle-orm";

import { findErrorCause } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import { roundTo } from "~/lib/round-to";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiUsage, appSettings } from "~/server/db/schema";
import { WorkDeferredError } from "~/server/kernel/work-errors";

import { aiBudgetWindow, fundingResumeAt } from "./budget-window";

/**
 * Household caps on frontier chat-model spend per fixed six-hour UTC window
 * (ADR 0027): the paid budget sums charged cost and the plan budget its
 * standard API cost. Provider credits have no window budget: they run until
 * the provider refuses, and the status reports their spend. Embeddings and
 * closed-set decision models are not budgeted. Admission (`paidRunPreflight`,
 * `withAiBudget`, `withPlanBudget`) and accounting (`readAiBudget`) share
 * `aiBudgetCovers`.
 */
export const AI_BUDGET_LIMIT_USD = 1;
const SETTINGS_ID = "00000000-0000-4000-8000-000000000077";
/** Chat models and cookbook's pinned frontier models, which spend the same credit. */
const FRONTIER_MODELS: readonly string[] = Object.entries(AI_MODELS)
  .filter(([, model]) => model.role === "chat" || model.role === "cookbook")
  .map(([id]) => id);
export const aiBudgetCovers = (model: string) =>
  FRONTIER_MODELS.includes(model);

export const budgetUsd = (value: number) => `$${roundTo(value, 4)}`;

/**
 * The funding ladder is exhausted: the window budget is spent or the paid rung
 * cannot answer. It is the one funding wait every Job, drain and Run step
 * recognizes, resuming at {@link fundingResumeAt} without spending an attempt.
 */
export class AiBudgetExhaustedError extends WorkDeferredError {
  constructor(
    readonly status: AiBudgetStatus,
    message = `AI budget reached: ${budgetUsd(status.paid.spentUsd)} of $${status.paid.limitUsd} paid since ${status.windowStart}; paid work resumes at ${status.windowEnd}.`,
  ) {
    super(
      message,
      fundingResumeAt(status.windowEnd),
      executionWaitReason.enum.ai_funding_window,
    );
    this.name = "AiBudgetExhaustedError";
  }
}

/** The funding wait anywhere in a failure's cause chain, if it has one. */
export const findFundingWait = (error: UnparsedError) =>
  findErrorCause(
    error,
    (cause): cause is WorkDeferredError =>
      cause instanceof WorkDeferredError &&
      cause.reason === executionWaitReason.enum.ai_funding_window,
  );

export async function setAiBudget(
  db: Database,
  settings: AiBudgetSettings,
): Promise<AiBudgetSettings> {
  const metadata = aiBudgetSettings.parse(settings);
  await getDb(db)
    .insert(appSettings)
    .values({ id: SETTINGS_ID, metadata })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { metadata, updatedAt: new Date() },
    });
  return metadata;
}

const creditUsageRow = sql`${aiUsage.costEvidence}->>'billingReason' = 'subscriber_credit'`;
const planUsageRow = sql`${aiUsage.costEvidence}->>'billingReason' = 'plan'`;

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
  const [row] = await getDb(db)
    .select({
      settings: sql<unknown[] | null>`(
          SELECT jsonb_build_array(${appSettings.metadata})
          FROM ${appSettings} WHERE ${appSettings.id} = ${SETTINGS_ID}
        )`,
      credit: sql<number>`COALESCE(sum(${aiUsage.standardCost}) FILTER (WHERE ${creditUsageRow} AND ${aiUsage.provider} = 'anthropic'), 0)::double precision`,
      openaiCredit: sql<number>`COALESCE(sum(${aiUsage.standardCost}) FILTER (WHERE ${creditUsageRow} AND ${aiUsage.provider} = 'openai'), 0)::double precision`,
      plan: sql<number>`COALESCE(sum(${aiUsage.standardCost}) FILTER (WHERE ${planUsageRow}), 0)::double precision`,
      paid: sql<number>`COALESCE(sum(COALESCE(${aiUsage.chargedCost}, ${aiUsage.standardCost}, 0)) FILTER (WHERE (${creditUsageRow}) IS NOT TRUE), 0)::double precision`,
    })
    .from(aiUsage)
    .where(
      and(
        gte(aiUsage.createdAt, window.start),
        inArray(aiUsage.model, [...FRONTIER_MODELS]),
      ),
    );
  // The aggregate returns a row even without usage. Wrapping metadata keeps
  // an absent settings row distinct from malformed stored JSON null.
  const settings = storedAiBudgetSettings.parse(
    row?.settings ? row.settings[0] : {},
  );
  return {
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    credit: { spentUsd: Math.max(0, row?.credit ?? 0) },
    openaiCredit: { spentUsd: Math.max(0, row?.openaiCredit ?? 0) },
    plan: {
      limitUsd: settings.planLimitUsd,
      spentUsd: Math.max(0, row?.plan ?? 0),
    },
    paid: {
      limitUsd: settings.paidLimitUsd,
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
 * A funding stop names its source, why it refused and when the Run retries,
 * keeping the provider's raw text. The window budget itself was not reached.
 * `<why>` is a missing BYOK credential or an empty AI Gateway balance; a stop
 * the paid rung did not refuse is the provider credit that ended the ladder.
 */
export function paidFundingStopMessage(raw: string, status: AiBudgetStatus) {
  const kind = paidFundingRefusal(raw)?.kind;
  const why =
    kind === "byok_missing"
      ? "the AI Gateway has no BYOK credential"
      : kind === "gateway_balance_empty"
        ? "AI Gateway balance empty"
        : "exhausted provider credit balance";
  return `Paid models unavailable: ${why} (${raw.trim()}); retrying at ${status.windowEnd}.`;
}

/**
 * Paid admission for a frontier call that has no Run-bound preflight: every
 * call, background included, spends within the paid budget, or past it by a
 * member's confirmed allowance. A stop pauses the call's Run, if any. A
 * supplied preflight owns the check itself (`paidRunPreflight`).
 */
export function withAiBudget<R>(
  db: Database | undefined,
  call: { model: string; runId?: RunId },
  preflight: ((request: R) => Promise<void>) | undefined,
): ((request: R) => Promise<void>) | undefined {
  if (preflight || !db || !aiBudgetCovers(call.model)) return preflight;
  return async () =>
    (await import("~/server/ai/funding-wait")).admitPaid(db, call);
}

/** Plan admission: background work stops drawing the ChatGPT plan once its window budget is spent. */
export function withPlanBudget<R>(
  db: Database | undefined,
  call: { model: string; runId?: RunId; interactive?: boolean },
  preflight: ((request: R) => Promise<string | null>) | undefined,
): ((request: R) => Promise<string | null>) | undefined {
  if (preflight || !db || !aiBudgetCovers(call.model)) return preflight;
  return async () => {
    const { isAutomaticAiCall, planBudgetRefusal } = await import("./funding");
    return (await isAutomaticAiCall(db, call)) ? planBudgetRefusal(db) : null;
  };
}

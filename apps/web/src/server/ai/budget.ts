import type { RunId } from "@cubby/schemas/identifiers";
import {
  aiBudgetSettings,
  type AiBudgetSettings,
  type AiBudgetStatus,
} from "@cubby/schemas/mail-import-settings";
import { supportedChatModelSchema } from "@cubby/shared/ai/models";
import { and, gte, inArray, isNull, sql } from "drizzle-orm";

import { roundTo } from "~/lib/round-to";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiUsage, appSettings } from "~/server/db/schema";

import { aiBudgetWindow } from "./budget-window";

/**
 * Household caps on frontier chat-model spend per fixed six-hour UTC window
 * (ADR 0017): the paid budget sums charged cost, and the Claude credit budget
 * sums the standard API cost of subscriber-credit calls, which charge $0.
 * Embeddings, closed-set decision models and other model roles are not
 * budgeted. Admission (`paidRunPreflight`, `withAiBudget`,
 * `withFreeBudget`) and accounting (`readAiBudget`) share `aiBudgetCovers`.
 */
export const AI_BUDGET_LIMIT_USD = 1;
/** About $180 a month of the household's $200 monthly Claude credit. */
export const DEFAULT_CREDIT_BUDGET_USD = 1.5;
/**
 * Cubby's slice of the household ChatGPT plan, whose quota the members' own
 * coding shares.
 */
export const PLAN_BUDGET_LIMIT_USD = 2;
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

export async function setCreditBudget(
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
      credit: sql<number>`COALESCE(sum(${aiUsage.standardCost}) FILTER (WHERE ${creditUsageRow}), 0)::double precision`,
      plan: sql<number>`COALESCE(sum(${aiUsage.standardCost}) FILTER (WHERE ${planUsageRow}), 0)::double precision`,
      paid: sql<number>`COALESCE(sum(COALESCE(${aiUsage.chargedCost}, ${aiUsage.standardCost}, 0)) FILTER (WHERE (${creditUsageRow}) IS NOT TRUE), 0)::double precision`,
    })
    .from(aiUsage)
    .where(
      and(
        gte(aiUsage.createdAt, window.start),
        isNull(aiUsage.deletedAt),
        inArray(aiUsage.model, [...FRONTIER_MODELS]),
      ),
    );
  // The aggregate returns a row even without usage. Wrapping metadata keeps
  // an absent settings row distinct from malformed stored JSON null.
  const settings = aiBudgetSettings.parse(
    row?.settings
      ? row.settings[0]
      : { creditLimitUsd: DEFAULT_CREDIT_BUDGET_USD },
  );
  return {
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    credit: {
      limitUsd: settings.creditLimitUsd,
      spentUsd: Math.max(0, row?.credit ?? 0),
    },
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
  const { runId } = call;
  return async () => {
    try {
      const allowanceUsd = runId
        ? ((await (await import("./funding")).readPaidAllowance(db, runId)) ??
          0)
        : 0;
      await assertAiBudget(db, allowanceUsd);
    } catch (error) {
      // A Run-bound stop pauses the Run for the next window, as the agent's
      // `paidRunPreflight` does, instead of failing it.
      if (runId && error instanceof AiBudgetExhaustedError)
        await (
          await import("~/server/domains/run/repo/execution-context")
        ).pauseForFunding(db, runId, error);
      throw error;
    }
  };
}

/** Free-rung admission: background work stops drawing credit or plan once that window budget is spent. */
export function withFreeBudget<R>(
  db: Database | undefined,
  call: { model: string; runId?: RunId },
  preflight:
    | ((
        request: R,
        funding: "subscriber_credit" | "subscription",
      ) => Promise<string | null>)
    | undefined,
):
  | ((
      request: R,
      funding: "subscriber_credit" | "subscription",
    ) => Promise<string | null>)
  | undefined {
  if (preflight || !db || !call.runId || !aiBudgetCovers(call.model))
    return preflight;
  const runId = call.runId;
  return async (_request, funding) => {
    const { isBackgroundRun, freeBudgetRefusal } = await import("./funding");
    return (await isBackgroundRun(db, runId))
      ? freeBudgetRefusal(db, funding)
      : null;
  };
}

import { aiEvaluationState } from "@cubby/schemas/ai-evaluation";
import type { RunId } from "@cubby/schemas/identifiers";
import { jobWaitReason } from "@cubby/schemas/job";
import type {
  AiBudgetStatus,
  AiFundingStatus,
  ChatGptPlanAvailability,
  FundingAvailability,
  FundingRefusalSource,
} from "@cubby/schemas/mail-import-settings";
import { runStatus } from "@cubby/schemas/run-fields";
import { classifyFundingRefusal } from "@cubby/shared/ai/funding-refusal";
import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";
import {
  and,
  count as countRows,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { getAiGatewayEgress } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiUsage,
  imageProcessingJob,
  run,
  searchDocument,
} from "~/server/db/schema";
import { readPaidGrant } from "~/server/domains/run/repo/paid-grant";

import { budgetUsd, readAiBudget } from "./budget";
import {
  AI_BUDGET_WINDOW_MS,
  aiBudgetWindow,
  fundingResumeAt,
} from "./budget-window";
import type { CreditRefusal } from "./gateway-egress-contract";

/*
 * What decides how background work is funded (ADR 0027): Run origin, recorded
 * credit refusals and the plan window. Loaded on use by `budget.ts`
 * admissions, so the request-path bundle carries only the budget reads.
 */

/** The refusal a background plan call receives once the plan's window budget is spent. */
export async function planBudgetRefusal(db: Database): Promise<string | null> {
  const status = await readAiBudget(db);
  const { plan } = status;
  return plan.spentUsd >= plan.limitUsd
    ? `ChatGPT plan budget reached: ${budgetUsd(plan.spentUsd)} of $${plan.limitUsd} standard cost since ${status.windowStart}; it resumes at ${status.windowEnd}.`
    : null;
}

const RECENT_MS = AI_BUDGET_WINDOW_MS;
export interface FundingStatusPorts {
  now?: Date;
  /** The household plan connection; null where no plan storage exists. */
  planConnection?: () => Promise<{
    connected: boolean;
    needsReauthorization: boolean;
    issue?: string | null;
  } | null>;
  /** The egress Durable Object's recorded credit refusal; null without one. */
  creditRefusal?: () => Promise<CreditRefusal | null>;
  openaiCreditRefusal?: () => Promise<CreditRefusal | null>;
  /** The egress Durable Object's recorded paid-gateway refusal. */
  paidRefusal?: () => Promise<CreditRefusal | null>;
}

/** The household's one egress object holds the credit refusal (ADR 0027). */
const egress = () => getAiGatewayEgress(CUBBY_AI_GATEWAY_ID);

/** Retry one source's recorded refusal now, or every source without one. */
export async function resetFundingRefusal(source?: FundingRefusalSource) {
  await egress()?.resetFundingRefusal(source);
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
      reason:
        connection.issue ?? "The household ChatGPT plan needs reauthorization.",
    };
  const [latest] = await getDb(db)
    .select({ createdAt: aiUsage.createdAt, failure: aiUsage.failure })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.transport, "chatgpt"),
        gte(aiUsage.createdAt, new Date(now.getTime() - RECENT_MS)),
      ),
    )
    .orderBy(desc(aiUsage.createdAt))
    .limit(1);
  // Only an exhausted quota pauses status; only OpenAI can supply its reset, and
  // Cubby's window is a probe deadline.
  const refusal = latest?.failure
    ? classifyFundingRefusal(
        { text: latest.failure, funding: "subscription" },
        latest.createdAt.getTime(),
      )
    : null;
  const quotaRefused = refusal?.kind === "plan_quota";
  const until =
    quotaRefused && refusal.until !== null ? new Date(refusal.until) : null;
  const probeAt =
    until ?? (latest ? aiBudgetWindow(latest.createdAt).end : null);
  return quotaRefused && probeAt && probeAt > now
    ? {
        state: "paused",
        until: until?.toISOString() ?? null,
        reason: latest?.failure ?? null,
      }
    : { state: "available", until: null, reason: null };
}

const refusalState = (refusal: CreditRefusal | null) =>
  refusal
    ? {
        state: "refused" as const,
        until: new Date(refusal.until).toISOString(),
        reason: refusal.reason,
      }
    : { state: "available" as const, until: null, reason: null };

const USABLE: FundingAvailability = {
  usable: true,
  blocker: null,
  until: null,
};
const blocked = (
  blocker: NonNullable<FundingAvailability["blocker"]>,
  until: string | null,
): FundingAvailability => ({ usable: false, blocker, until });

/**
 * One verdict per source for background work: a recorded refusal or
 * connection problem outranks a spent window budget, which resets at the
 * window end.
 */
function availability(
  use: { spentUsd: number; limitUsd?: number },
  windowEnd: string,
  refused: {
    blocker: NonNullable<FundingAvailability["blocker"]>;
    until: string | null;
  } | null,
): FundingAvailability {
  if (refused) return blocked(refused.blocker, refused.until);
  // A provider credit has no window budget; only its refusal stops it.
  return use.limitUsd !== undefined && use.spentUsd >= use.limitUsd
    ? blocked("budget_spent", windowEnd)
    : USABLE;
}

const PLAN_BLOCKER = {
  available: null,
  paused: "plan_limit",
  disconnected: "disconnected",
  needs_reauthorization: "needs_reauthorization",
} as const satisfies Record<
  ChatGptPlanAvailability["state"],
  FundingAvailability["blocker"]
>;

/** What the funding wake (`resumeFundingPausedRuns`) would bring back now. */
async function readFundingWaits(db: Database) {
  const funding = jobWaitReason.enum.ai_funding_window;
  const count = async (table: PgTable, where: SQL | undefined) =>
    (await getDb(db).select({ n: countRows() }).from(table).where(where))[0]
      ?.n ?? 0;
  const [runs, evaluations, embeddings, images] = await Promise.all([
    count(
      run,
      and(
        eq(run.status, runStatus.enum.paused_auth),
        eq(run.failureCode, "execution_limit"),
        notDeleted(run),
        isNull(run.retiredAt),
      ),
    ),
    count(
      aiEvaluation,
      and(
        eq(aiEvaluation.waitCause, funding),
        inArray(aiEvaluation.state, [
          aiEvaluationState.enum.queued,
          aiEvaluationState.enum.result_ready,
        ]),
        gt(aiEvaluation.runAt, sql`now()`),
      ),
    ),
    count(
      searchDocument,
      and(
        gt(searchDocument.embeddingDueAt, sql`now()`),
        isNull(searchDocument.embeddingFailingSince),
        isNotNull(searchDocument.embeddingError),
        notDeleted(searchDocument),
      ),
    ),
    count(
      imageProcessingJob,
      and(
        eq(imageProcessingJob.state, "pending"),
        eq(imageProcessingJob.waitReason, funding),
        gt(imageProcessingJob.runAt, sql`now()`),
      ),
    ),
  ]);
  return { runs, work: evaluations + embeddings + images };
}

export async function readAiFundingStatus(
  db: Database,
  ports: FundingStatusPorts = {},
): Promise<AiFundingStatus> {
  const {
    creditRefusal = async () => (await egress()?.creditRefusal()) ?? null,
    openaiCreditRefusal = async () =>
      (await egress()?.creditRefusal(undefined, "openai")) ?? null,
    paidRefusal = async () => (await egress()?.paidRefusal()) ?? null,
  } = ports;
  const [budget, plan, refusal, openaiRefusal, paidRefused, waits]: [
    AiBudgetStatus,
    ChatGptPlanAvailability,
    CreditRefusal | null,
    CreditRefusal | null,
    CreditRefusal | null,
    { runs: number; work: number },
  ] = await Promise.all([
    readAiBudget(db, ports.now),
    readChatGptPlanAvailability(db, ports),
    creditRefusal(),
    openaiCreditRefusal(),
    paidRefusal(),
    readFundingWaits(db),
  ]);
  const credit = refusalState(refusal);
  const openaiCredit = refusalState(openaiRefusal);
  const paid = refusalState(paidRefused);
  const planBlocker = PLAN_BLOCKER[plan.state];
  const refusedBy = (
    state: ReturnType<typeof refusalState>,
    blocker: NonNullable<FundingAvailability["blocker"]>,
  ) => (state.state === "refused" ? { blocker, until: state.until } : null);
  return {
    ...budget,
    waiting: {
      ...waits,
      resumeAt:
        waits.runs || waits.work
          ? fundingResumeAt(budget.windowEnd).toISOString()
          : null,
    },
    credit: {
      ...budget.credit,
      ...credit,
      availability: availability(
        budget.credit,
        budget.windowEnd,
        refusedBy(credit, "provider_refused"),
      ),
    },
    openaiCredit: {
      ...budget.openaiCredit,
      ...openaiCredit,
      availability: availability(
        budget.openaiCredit,
        budget.windowEnd,
        refusedBy(openaiCredit, "provider_refused"),
      ),
    },
    plan: {
      ...budget.plan,
      ...plan,
      availability: availability(
        budget.plan,
        budget.windowEnd,
        planBlocker ? { blocker: planBlocker, until: plan.until } : null,
      ),
    },
    paid: {
      ...budget.paid,
      ...paid,
      availability: availability(
        budget.paid,
        budget.windowEnd,
        refusedBy(paid, "gateway_balance_empty"),
      ),
    },
  };
}

/**
 * Why a background Run's escalation cannot be funded for free now, else null.
 * Every tier walks the same sources, so it depends only on them: both credits
 * are refused and the plan's window budget is spent, and the escalated Email
 * would only reach paid funding. Interactive Runs escalate through the ladder.
 */
export async function escalationFundingRefusal(
  db: Database,
  runId: RunId,
): Promise<string | null> {
  if (!(await isBackgroundRun(db, runId))) return null;
  const claude = await egress()?.creditRefusal();
  if (!claude) return null;
  const openai = await egress()?.creditRefusal(undefined, "openai");
  if (!openai) return null;
  const plan = await planBudgetRefusal(db);
  return (
    plan &&
    `Claude credit refused until ${new Date(claude.until).toISOString()}; OpenAI credit refused until ${new Date(openai.until).toISOString()}; ${plan}`
  );
}

/**
 * Whether this call stops at its window budget. It fails closed: a call with no Run
 * is automatic unless it says a member is waiting, so a caller that forgets the
 * signal can never spend past the budget.
 */
export const isAutomaticAiCall = async (
  db: Database,
  call: { runId?: RunId; interactive?: boolean },
) => (call.runId ? isBackgroundRun(db, call.runId) : !call.interactive);

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
  const known = backgroundRuns.get(runId);
  if (known) return (await known) ?? false;
  const lookup = readBackgroundRun(db, runId);
  if (backgroundRuns.size >= 1000) backgroundRuns.clear();
  // Publish before awaiting so a page's simultaneous calls share the cold read.
  // Only immutable origin is retained; budgets and grants still read fresh.
  backgroundRuns.set(runId, lookup);
  try {
    const background = await lookup;
    if (background === null && backgroundRuns.get(runId) === lookup)
      backgroundRuns.delete(runId);
    return background ?? false;
  } catch (error) {
    if (backgroundRuns.get(runId) === lookup) backgroundRuns.delete(runId);
    throw error;
  }
}

/**
 * Every frontier admission asks this, and each read competes for a pooled
 * connection (pool-slot timeouts failed Runs on 2026-10-19), so an isolate
 * remembers it.
 */
const backgroundRuns = new Map<RunId, Promise<boolean | null>>();

async function readBackgroundRun(
  db: Database,
  runId: RunId,
): Promise<boolean | null> {
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
    if (!row) return null;
    if (!row.predecessorRunId || visited.has(row.predecessorRunId))
      return (
        row.purpose === "background" ||
        BACKGROUND_TRIGGERS.includes(row.trigger)
      );
    current = row.predecessorRunId;
  }
  return null;
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

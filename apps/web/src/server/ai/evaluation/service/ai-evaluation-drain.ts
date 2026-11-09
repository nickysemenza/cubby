import { aiEvaluationTarget } from "@cubby/schemas/ai-evaluation";

import { createConcurrencyLimiter } from "~/lib/concurrency-limiter";
import { findErrorCause, scrubErrorMessage } from "~/lib/error-diagnostics";
/**
 * The AI evaluation drain (docs/jobs.md#ai-evaluation-drains): pages through the
 * evaluations each feature owes, with no Job or `DrainItem` row. Product and
 * connection refresh evaluate a whole page and publish it in fenced chunks; other
 * features run each item's own guarded transactions under their lease. Activation,
 * pending state and generation are checked here; requester Runs and feature
 * execution arrive through `AiEvaluationExecution`; `rowDrain` owns publication,
 * attempts and backoff.
 */
import { AiBudgetExhaustedError } from "~/server/ai/budget";
import { aiWorkDeferral } from "~/server/ai/cooperative-work";
import {
  AiEvaluationAttemptObsoleteError,
  AiEvaluationUnauthorizedError,
  aiEvaluationAuthorizations,
  claimAiEvaluation,
  type ClaimedAiEvaluation,
  failAiEvaluations,
  guardAiEvaluationPage,
  lockAiEvaluationPage,
  readAiEvaluations,
  settleAiEvaluations,
} from "~/server/ai/evaluation/repo/ai-evaluation";
import { PENDING_AI_STATES } from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import {
  aiEvaluationDue,
  aiEvaluationNext,
  aiEvaluationPageHeld,
  aiEvaluationPageKey,
  aiEvaluationStore,
  deferAiEvaluationFeature,
  releaseAiEvaluationPage,
} from "~/server/ai/evaluation/repo/ai-evaluation-work";
import type {
  EvaluationPagePublication,
  EvaluationPageTarget,
} from "~/server/ai/evaluation/repo/evaluation-page";
import {
  gatewayAdmissionWait,
  GatewayProviderStopError,
} from "~/server/ai/gateway-egress-client";
import {
  compiledRefreshManifest,
  dependenciesCurrent,
} from "~/server/ai/policy/refresh-manifest";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import {
  repositorySnapshotWriteDatabase,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import {
  rowDrain,
  type DrainContext,
  stopsDrainPage,
} from "~/server/generic/background/drains";
import type { DrainItem } from "~/server/generic/jobs/drain-store";
import {
  JobDeferredError,
  JobEvidenceObsoleteError,
  JobSupersededError,
} from "~/server/generic/jobs/errors";
import { classifyJobFailure } from "~/server/generic/jobs/failure";
import type { JobContext } from "~/server/generic/jobs/types";

/**
 * Feature execution and requester-Run authority, supplied by the Run domain.
 * The drain owns items, attempts and fences; an adapter never sees the queue.
 */
export type AiEvaluationExecution = {
  /** One evaluation through its own guarded transactions under the drain's fence. */
  execute(
    db: Database,
    evaluation: ClaimedAiEvaluation,
    context: DrainContext,
  ): Promise<void>;
  pauseRun(db: Database, runId: string, message: string): Promise<void>;
  runPaused(db: Database, runId: string): Promise<boolean>;
  /** The page runs once its funding window opened: resume Runs a budget stop paused. */
  resumeFundingStopped(db: Database, runIds: readonly string[]): Promise<void>;
};

/** Items per Job page; the rest stay owed and rejoin fair selection after this page's checkpoint. */
const PAGE_LIMIT = 8;
const ITEM_CONCURRENCY = 2;
/** Consecutive failures before an item settles its evaluation `failed`. */
const AI_EVALUATION_MAX_ATTEMPTS = 3;
const AI_EVALUATION_BACKOFF = { baseMs: 60_000, maxMs: 15 * 60_000 };

type Entry =
  /** Nothing pending, or a newer attempt owns the evaluation. */
  | { kind: "skip" }
  /** No live Run authorizes it: the item clears; resume re-marks it. */
  | { kind: "park" }
  /** The item's own transactions already committed its outcome. */
  | { kind: "settled" }
  /** External stop: retain the ticket while paid siblings publish before feature deferral. */
  | { kind: "defer" }
  | { kind: "obsolete"; reason: string }
  | { kind: "fail"; error: string };

type Prepared = {
  targets: Map<string, EvaluationPageTarget>;
  entries: Map<string, Entry>;
};

const errorMessage = (error: unknown) =>
  scrubErrorMessage(error instanceof Error ? error.message : String(error));

const evidenceObsolete = (error: unknown) =>
  findErrorCause(
    error,
    (cause): cause is JobEvidenceObsoleteError =>
      cause instanceof JobEvidenceObsoleteError,
  ) !== undefined;

/** The same external wait applies whether a target or its whole preparation page escaped. */
function evaluationDeferral(error: unknown) {
  const is = <E extends Error>(type: abstract new (...args: never[]) => E) =>
    findErrorCause(error, (cause): cause is E => cause instanceof type);
  const message = errorMessage(error);
  const budget = is(AiBudgetExhaustedError);
  if (budget)
    return new JobDeferredError(
      message,
      new Date(budget.resumeAt),
      "ai_funding_window",
    );
  const capacity = aiWorkDeferral(error);
  if (capacity)
    return new JobDeferredError(
      message,
      new Date(capacity.until),
      "provider_capacity",
    );
  const admission = gatewayAdmissionWait(error);
  if (admission)
    return new JobDeferredError(
      message,
      new Date(admission.retryAt),
      "rate_limit",
    );
  const provider = is(GatewayProviderStopError);
  if (provider)
    return new JobDeferredError(
      message,
      new Date(provider.retryAt),
      "provider_capacity",
    );
  return undefined;
}

/**
 * Domain failures at the drain seam: evidence changes settle obsolete,
 * capacity and funding stop the page without spending attempts, pending
 * upstream coverage postpones only its item, and a stopped requester parks the
 * item. Everything else is the item's failure.
 */
async function mapFailure(
  db: Database,
  execution: AiEvaluationExecution,
  target: EvaluationPageTarget,
  error: unknown,
): Promise<{ entry: Entry } | { failed: unknown }> {
  const is = <E extends Error>(type: abstract new (...args: never[]) => E) =>
    findErrorCause(error, (cause): cause is E => cause instanceof type);
  if (is(AiEvaluationAttemptObsoleteError)) return { entry: { kind: "skip" } };
  if (is(AiEvaluationUnauthorizedError)) return { entry: { kind: "park" } };
  if (stopsDrainPage(error)) return { failed: error };
  const message = errorMessage(error);
  const deferred = evaluationDeferral(error);
  if (deferred) return { failed: deferred };
  if (evidenceObsolete(error))
    return { entry: { kind: "obsolete", reason: message } };
  const { evaluation } = target;
  if (evaluation.executionKind !== "ai_refresh" && evaluation.runId) {
    if (/mailbox.*connected/i.test(message)) {
      await execution.pauseRun(db, evaluation.runId, message);
      return { entry: { kind: "park" } };
    }
    if (await execution.runPaused(db, evaluation.runId))
      return { entry: { kind: "park" } };
  }
  return { failed: error };
}

async function prepareItems(
  db: Database,
  runnable: readonly EvaluationPageTarget[],
  context: DrainContext,
  execution: AiEvaluationExecution,
  settle: (target: EvaluationPageTarget, error: unknown) => Promise<void>,
  entries: Map<string, Entry>,
) {
  const limiter = createConcurrencyLimiter(ITEM_CONCURRENCY);
  await Promise.allSettled(
    runnable.map((target) =>
      limiter.run(async () => {
        try {
          const claimed = await claimAiEvaluation(context, target.item);
          if (!claimed) {
            entries.set(target.item.ref, { kind: "skip" });
            return;
          }
          await execution.execute(db, claimed, context);
          const [settled] = await readAiEvaluations(db, [claimed.id]);
          // A re-marked item keeps its newer ticket, so this never clears it.
          if (settled && PENDING_AI_STATES.includes(settled.state))
            throw new Error("AI evaluation returned without a durable outcome");
          entries.set(target.item.ref, { kind: "settled" });
        } catch (error) {
          await settle(target, error);
        }
      }, context.signal),
    ),
  );
  if (context.signal.aborted) throw context.signal.reason;
}

function aiEvaluationPage(
  execution: AiEvaluationExecution,
  feature: string,
  token: string,
  context: DrainContext,
  publicationTransaction: JobContext["fenced"],
) {
  let deferred: JobDeferredError | undefined;
  const store = aiEvaluationStore(feature, token);
  const drain = rowDrain<Prepared>({
    transaction: publicationTransaction,
    store,
    backoff: AI_EVALUATION_BACKOFF,
    limit: PAGE_LIMIT,
    isolationLevel: "serializable",
    maxAttempts: AI_EVALUATION_MAX_ATTEMPTS,
    async prepare(db, items) {
      const targets = new Map<string, EvaluationPageTarget>();
      const entries = new Map<string, Entry>();
      const failed = new Map<DrainItem, unknown>();
      const rows = new Map(
        (
          await readAiEvaluations(
            db,
            items.map((item) => item.ref),
          )
        ).map((row) => [row.id, row]),
      );
      const live: EvaluationPageTarget[] = [];
      for (const item of items) {
        const row = rows.get(item.ref);
        if (!row) {
          entries.set(item.ref, { kind: "skip" });
          continue;
        }
        const target = {
          item,
          evaluation: row,
          target: aiEvaluationTarget.parse(row.target),
        };
        targets.set(item.ref, target);
        if (PENDING_AI_STATES.includes(row.state)) live.push(target);
        else entries.set(item.ref, { kind: "skip" });
      }
      const refresh = live.filter(
        (entry) => entry.evaluation.executionKind === "ai_refresh",
      );
      if (refresh.length) {
        const activation = await readAiRefreshActivation(db);
        if (!activation?.enabled)
          throw new JobDeferredError(
            "Automatic AI refresh is disabled",
            new Date(Date.now() + 120_000),
            "provider_capacity",
          );
        const compiled = await compiledRefreshManifest();
        // Obsolete generations retire as one set before any provider work.
        for (const entry of refresh) {
          const provenance = entry.evaluation.provenance;
          if (!dependenciesCurrent(provenance, activation.manifest))
            entries.set(entry.item.ref, {
              kind: "obsolete",
              reason: "AI evaluation generation is obsolete",
            });
          else if (
            !dependenciesCurrent(
              {
                ...provenance,
                dependencies: provenance.dependencies.map((stamp) => ({
                  ...stamp,
                  generation: 0,
                })),
              },
              compiled,
            )
          )
            entries.set(entry.item.ref, {
              kind: "obsolete",
              reason: "AI evaluation Worker prompt manifest is obsolete",
            });
        }
      }
      const current = live.filter((entry) => !entries.has(entry.item.ref));
      // The drain deferred until the funding window, so running again is the
      // window opening for the Runs a budget stop paused.
      await execution.resumeFundingStopped(db, [
        ...new Set(current.flatMap((entry) => entry.evaluation.runId ?? [])),
      ]);
      const authorization = await aiEvaluationAuthorizations(
        db,
        current.map((entry) => entry.evaluation),
        false,
      );
      for (const entry of current)
        if (!authorization.has(entry.evaluation.id))
          entries.set(entry.item.ref, { kind: "park" });
      const runnable = current.filter((entry) =>
        authorization.has(entry.evaluation.id),
      );
      const settle = async (target: EvaluationPageTarget, error: unknown) => {
        const mapped = await mapFailure(db, execution, target, error);
        if ("entry" in mapped) entries.set(target.item.ref, mapped.entry);
        else {
          const stop = findErrorCause(
            mapped.failed,
            (cause): cause is JobDeferredError =>
              cause instanceof JobDeferredError,
          );
          if (stop) {
            entries.set(target.item.ref, { kind: "defer" });
            if (!deferred || stop.until > deferred.until) deferred = stop;
          } else failed.set(target.item, mapped.failed);
        }
      };
      await prepareItems(db, runnable, context, execution, settle, entries);
      return { prepared: { targets, entries }, failed };
    },
    async lock(tx, items, prepared) {
      await lockAiEvaluationPage(
        tx,
        items.flatMap((item) => {
          const kind = prepared.entries.get(item.ref)?.kind;
          const target = prepared.targets.get(item.ref);
          return target &&
            kind !== "skip" &&
            kind !== "settled" &&
            kind !== "defer"
            ? [target]
            : [];
        }),
      );
      return items;
    },
    async publish(tx, items, prepared) {
      const held = items.flatMap((item) => {
        const target = prepared.targets.get(item.ref);
        const entry = prepared.entries.get(item.ref);
        return target && entry ? [{ target, entry }] : [];
      });
      // Resume takes the same Run locks before re-admitting demand. Keep a
      // parked ticket if that demand resumed after page preparation.
      const parked = held.filter(({ entry }) => entry.kind === "park");
      const authorization = await aiEvaluationAuthorizations(
        tx,
        parked.map(({ target }) => target.evaluation),
        false,
      );
      const retain = [
        ...parked
          .filter(({ target }) => authorization.has(target.evaluation.id))
          .map(({ target }) => target.item),
        ...held.flatMap(({ target, entry }) =>
          entry.kind === "defer" ? [target.item] : [],
        ),
      ];
      const written = held.filter(
        ({ entry }) => entry.kind === "obsolete" || entry.kind === "fail",
      );
      if (!written.length) return { retain };
      const { valid, stale } = await guardAiEvaluationPage(
        tx,
        written.map(({ target }) => target),
      );
      const validIds = new Set(valid.map((entry) => entry.evaluation.id));
      const current = written.filter(({ target }) =>
        validIds.has(target.evaluation.id),
      );
      const publications: EvaluationPagePublication[] = [];
      for (const { target, entry } of current)
        if (entry.kind === "obsolete")
          publications.push({
            evaluationId: target.evaluation.id,
            state: "obsolete",
            receipt: { reason: entry.reason },
          });
      for (const id of stale)
        publications.push({
          evaluationId: id,
          state: "obsolete",
          receipt: { reason: "AI evaluation generation is obsolete" },
        });
      await settleAiEvaluations(tx, publications);
      for (const { target, entry } of current)
        if (entry.kind === "fail")
          await failAiEvaluations(tx, [target.evaluation.id], entry.error);
      return { retain };
    },
    async exhaust(tx, items, error) {
      await failAiEvaluations(
        tx,
        items.map((item) => item.ref),
        error,
      );
      await store.clear(tx, items);
    },
  });
  return { drain, deferral: () => deferred };
}

export type AiEvaluationPageOutcome =
  | "skipped"
  | "succeeded"
  | "superseded"
  | "deferred"
  | "failed";

/**
 * One feature's page under a fresh lease. A provider or funding wait stops the
 * feature, a lost lease ends the page quietly, and an escaped error waits out a
 * backoff on the rows without spending their attempts, since it is no item's fault.
 * Whatever the page did not settle goes back due, unchanged.
 */
export async function runAiEvaluationPage(
  db: Database,
  execution: AiEvaluationExecution,
  feature: string,
  /** A test seam around the page's transactions. */
  around: (context: JobContext) => JobContext = (context) => context,
): Promise<{ outcome: AiEvaluationPageOutcome; claimed: number }> {
  const token = crypto.randomUUID();
  const assertHeld = async (client: Database) => {
    if (!(await aiEvaluationPageHeld(client, token)))
      throw new JobSupersededError();
  };
  const context = around({
    signal: new AbortController().signal,
    // Each row's lease is checked under its own lock when published, so there is
    // no commit-time fence here: a chunk's last publish clears the leases it read.
    fenced: (work, options) =>
      (options?.isolationLevel === "serializable"
        ? repositorySnapshotWriteDatabase
        : repositoryTransactionDatabase)(db, work),
    fence: assertHeld,
    check: () => assertHeld(db),
  });
  try {
    const preparedPage = aiEvaluationPage(
      execution,
      feature,
      token,
      {
        ...context,
        name: aiEvaluationPageKey(feature),
        attemptToken: token,
        fenced: (work, options) =>
          context.fenced(async (tx) => {
            await assertHeld(tx);
            return work(tx);
          }, options),
      },
      // Publication checks only its locked chunk's leases; a page-wide read
      // here creates serialization dependencies on unrelated evaluation work.
      context.fenced,
    );
    const page = await preparedPage.drain(db);
    const deferred = preparedPage.deferral();
    if (deferred) {
      await deferAiEvaluationFeature(
        db,
        feature,
        token,
        deferred.until,
        deferred.reason,
        deferred.message,
      );
      return { outcome: "deferred", claimed: page.claimed };
    }
    return {
      outcome: page.claimed ? "succeeded" : "skipped",
      claimed: page.claimed,
    };
  } catch (error) {
    let failure = classifyJobFailure(error);
    if (failure.kind === "failed" || failure.kind === "transient") {
      const deferred = evaluationDeferral(error);
      if (deferred) failure = classifyJobFailure(deferred);
    }
    if (failure.kind === "deferred") {
      await deferAiEvaluationFeature(
        db,
        feature,
        token,
        failure.until,
        failure.reason ?? "provider_capacity",
        errorMessage(error),
      );
      // The page ran: its successor permit waits for the deferral to end.
      return { outcome: "deferred", claimed: 1 };
    }
    if (failure.kind === "interrupted")
      return { outcome: "superseded", claimed: 0 };
    await deferAiEvaluationFeature(
      db,
      feature,
      token,
      new Date(Date.now() + AI_EVALUATION_BACKOFF.baseMs),
      "page_failed",
      errorMessage(error),
    );
    throw error;
  } finally {
    await releaseAiEvaluationPage(db, token);
  }
}

/** One unit per feature (`ai-evaluation:<feature>`); a permit pages one of them. */
export function aiEvaluationDrain(
  execution: AiEvaluationExecution,
): BackgroundDrain {
  const name = "ai-evaluation";
  return {
    name,
    due: () => aiEvaluationDue(name),
    next: aiEvaluationNext,
    async page(db, unit) {
      const feature = unit.slice(name.length + 1);
      const { outcome, claimed } = await runAiEvaluationPage(
        db,
        execution,
        feature,
      );
      // A funding or provider wait is the page's recorded outcome, not success.
      return outcome === "failed" ? { claimed } : { outcome, claimed };
    },
  };
}

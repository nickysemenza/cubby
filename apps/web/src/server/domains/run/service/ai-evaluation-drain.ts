/**
 * The `ai.evaluation` drain (docs/jobs.md#drains): one Job per feature pages
 * through evaluation items. Product and connection refresh evaluate a whole
 * page and publish it in fenced chunks; other features run each item's own
 * guarded transactions under the drain lease. Domain authority (live Run,
 * activation, pending state, generation) is checked here; the drain owns
 * leases, attempts and backoff.
 */
import { aiEvaluationTarget } from "@cubby/schemas/ai-evaluation";

import { createConcurrencyLimiter } from "~/lib/concurrency-limiter";
import { findErrorCause, scrubErrorMessage } from "~/lib/error-diagnostics";
import { AiBudgetExhaustedError } from "~/server/ai/budget";
import { aiWorkDeferral } from "~/server/ai/cooperative-work";
import {
  compiledRefreshManifest,
  dependenciesCurrent,
} from "~/server/ai/policy/refresh-manifest";
import {
  AiEvaluationAttemptObsoleteError,
  AiEvaluationUnauthorizedError,
  aiEvaluationAuthorizations,
  claimAiEvaluation,
  failAiEvaluations,
  fenceAiEvaluationPage,
  guardAiEvaluationPage,
  lockAiEvaluationPage,
  readAiEvaluations,
  settleAiEvaluations,
  withAiEvaluationSavepoint,
} from "~/server/ai/repo/ai-evaluation";
import { PENDING_AI_STATES } from "~/server/ai/repo/ai-evaluation-requests";
import { markAiEvaluationWork } from "~/server/ai/repo/ai-evaluation-work";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type {
  EvaluationPagePublication,
  EvaluationPageTarget,
} from "~/server/ai/repo/evaluation-page";
import type { Database } from "~/server/db";
import { ConnectionEvidenceInvalidatedError } from "~/server/domains/connection/repo/entity-connections";
import { JobDeferredError, JobTargetError } from "~/server/generic/jobs/errors";
import { classifyJobFailure, stopsPage } from "~/server/generic/jobs/failure";
import type { WorkItem } from "~/server/generic/jobs/repo/work-items";
import { defineDrain } from "~/server/generic/jobs/service/drain";
import type { JobContext, JobHandler } from "~/server/generic/jobs/types";
import { withWorkflowExecution } from "~/server/workflows/runs/execution";

import {
  pauseRunForAiWork,
  readAiEvaluation,
  readRunStatus,
  resumeFundingStoppedRuns,
} from "../repo/ai-work-state";
import {
  executeAiRefreshTarget,
  prepareAiRefreshPage,
  type AiRefreshPorts,
  type PreparedAiRefreshPage,
} from "./ai-refresh";
import { executeAiWorkTarget, type AiWorkPorts } from "./ai-work";

export type AiEvaluationPorts = AiRefreshPorts & AiWorkPorts;

/** Features whose evaluations share one page preparation and decision wave. */
const PAGE_FEATURES = new Set(["product-identity", "entity-connections"]);
/** Items per page for features that run each item's own transactions. */
const ITEM_PAGE_LIMIT = 8;
const ITEM_CONCURRENCY = 2;
/** Consecutive failures before an item settles its evaluation `failed`. */
const AI_EVALUATION_MAX_ATTEMPTS = 3;

type Entry =
  /** Nothing pending, or a newer attempt owns the evaluation. */
  | { kind: "skip" }
  /** No live Run authorizes it: the item clears; resume re-marks it. */
  | { kind: "park" }
  /** The item's own transactions already committed its outcome. */
  | { kind: "settled" }
  | { kind: "outcome" }
  | { kind: "obsolete"; reason: string }
  | { kind: "fail"; error: string };

type Prepared = {
  targets: Map<string, EvaluationPageTarget>;
  entries: Map<string, Entry>;
  page?: PreparedAiRefreshPage;
};

const OBSOLETE =
  /obsolete|changed during inference|changed during evaluation|decided during inference|no longer exists|Connection (discovery )?source changed/;

const errorMessage = (error: unknown) =>
  scrubErrorMessage(error instanceof Error ? error.message : String(error));

const evidenceObsolete = (error: unknown) =>
  !!findErrorCause(
    error,
    (cause): cause is ConnectionEvidenceInvalidatedError =>
      cause instanceof ConnectionEvidenceInvalidatedError,
  ) || OBSOLETE.test(errorMessage(error));

/**
 * Domain failures at the drain seam: evidence changes settle obsolete,
 * capacity and funding stop the page without spending attempts, and a
 * stopped requester parks the item. Everything else is the item's failure.
 */
async function mapFailure(
  db: Database,
  target: EvaluationPageTarget,
  error: unknown,
): Promise<{ entry: Entry } | { failed: unknown }> {
  const is = <E extends Error>(type: abstract new (...args: never[]) => E) =>
    findErrorCause(error, (cause): cause is E => cause instanceof type);
  if (is(AiEvaluationAttemptObsoleteError)) return { entry: { kind: "skip" } };
  if (is(AiEvaluationUnauthorizedError)) return { entry: { kind: "park" } };
  if (stopsPage(classifyJobFailure(error))) return { failed: error };
  const message = errorMessage(error);
  const budget = is(AiBudgetExhaustedError);
  if (budget)
    return {
      failed: new JobDeferredError(
        message,
        new Date(budget.resumeAt),
        "ai_funding_window",
      ),
    };
  const capacity = aiWorkDeferral(error);
  if (capacity)
    return {
      failed: new JobDeferredError(
        message,
        new Date(capacity.until),
        "provider_capacity",
      ),
    };
  if (message.includes("AI Gateway admission is waiting"))
    return {
      failed: new JobDeferredError(
        message,
        new Date(Date.now() + 30_000),
        "rate_limit",
      ),
    };
  if (evidenceObsolete(error))
    return { entry: { kind: "obsolete", reason: message } };
  const { evaluation } = target;
  if (evaluation.executionKind !== "ai_refresh") {
    if (/mailbox.*connected/i.test(message)) {
      await pauseRunForAiWork(db, evaluation.runId, message);
      return { entry: { kind: "park" } };
    }
    if ((await readRunStatus(db, evaluation.runId)) === "paused")
      return { entry: { kind: "park" } };
  }
  return { failed: error };
}

async function prepareItems(
  db: Database,
  runnable: readonly EvaluationPageTarget[],
  context: JobContext,
  ports: AiEvaluationPorts,
  settle: (target: EvaluationPageTarget, error: unknown) => Promise<void>,
  entries: Map<string, Entry>,
  generation: number,
) {
  const limiter = createConcurrencyLimiter(ITEM_CONCURRENCY);
  await Promise.allSettled(
    runnable.map((target) =>
      limiter.run(async () => {
        try {
          const claimed = await claimAiEvaluation(db, target.item);
          if (!claimed) {
            entries.set(target.item.ref, { kind: "skip" });
            return;
          }
          await withWorkflowExecution(
            { runId: claimed.runId, attempt: generation, database: db },
            () =>
              claimed.executionKind === "ai_refresh"
                ? executeAiRefreshTarget(db, claimed, ports)
                : executeAiWorkTarget(db, claimed, ports),
          );
          const settled = await readAiEvaluation(db, claimed.id);
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

function aiEvaluationDrainSpec(ports: AiEvaluationPorts, paged: boolean) {
  return defineDrain<Prepared>({
    limit: paged ? 100 : ITEM_PAGE_LIMIT,
    isolationLevel: "serializable",
    maxAttempts: AI_EVALUATION_MAX_ATTEMPTS,
    weight: (item, prepared) => prepared.page?.ready.get(item.ref)?.weight ?? 1,
    async prepare(db, items, context) {
      const targets = new Map<string, EvaluationPageTarget>();
      const entries = new Map<string, Entry>();
      const failed = new Map<WorkItem, unknown>();
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
      await resumeFundingStoppedRuns(db, [
        ...new Set(current.map((entry) => entry.evaluation.runId)),
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
        const mapped = await mapFailure(db, target, error);
        if ("entry" in mapped) entries.set(target.item.ref, mapped.entry);
        else failed.set(target.item, mapped.failed);
      };
      if (!paged) {
        await prepareItems(
          db,
          runnable,
          context,
          ports,
          settle,
          entries,
          context.claim.generation,
        );
        return { prepared: { targets, entries }, failed };
      }
      if (!runnable.length) return { prepared: { targets, entries }, failed };
      const page = await prepareAiRefreshPage(db, runnable, context, ports);
      const overflow = new Set(page.overflow);
      for (const target of runnable) {
        const id = target.evaluation.id;
        const oversized = page.oversized.get(id);
        if (page.ready.has(id)) entries.set(id, { kind: "outcome" });
        else if (oversized) entries.set(id, { kind: "fail", error: oversized });
        else if (overflow.has(id)) entries.set(id, { kind: "skip" });
        else await settle(target, page.failures.get(id));
      }
      // A fresh ticket keeps the evidence suffix due for the next page
      // without spending an attempt.
      if (overflow.size)
        await context.fenced((tx) => markAiEvaluationWork(tx, [...overflow]));
      return { prepared: { targets, entries, page }, failed };
    },
    async lock(tx, items, prepared) {
      await lockAiEvaluationPage(
        tx,
        items.flatMap((item) => {
          const kind = prepared.entries.get(item.ref)?.kind;
          const target = prepared.targets.get(item.ref);
          return target &&
            kind !== "skip" &&
            kind !== "park" &&
            kind !== "settled"
            ? [target]
            : [];
        }),
      );
    },
    async publish(tx, items, prepared) {
      const held = items.flatMap((item) => {
        const target = prepared.targets.get(item.ref);
        const entry = prepared.entries.get(item.ref);
        return target && entry ? [{ target, entry }] : [];
      });
      const written = held.filter(
        ({ entry }) =>
          entry.kind === "outcome" ||
          entry.kind === "obsolete" ||
          entry.kind === "fail",
      );
      if (!written.length) return;
      const { valid, stale } = await guardAiEvaluationPage(
        tx,
        written.map(({ target }) => target),
      );
      const validIds = new Set(valid.map((entry) => entry.evaluation.id));
      const current = written.filter(({ target }) =>
        validIds.has(target.evaluation.id),
      );
      let ready = current.filter(({ entry }) => entry.kind === "outcome");
      const publications: EvaluationPagePublication[] = [];
      if (ready.length) {
        const ids = ready.map(({ target }) => target.evaluation.id);
        let published: EvaluationPagePublication[];
        try {
          published = await withAiEvaluationSavepoint(tx, (savepoint) =>
            prepared.page!.publish(savepoint, ids),
          );
        } catch (error) {
          // Evidence that changed during inference settles obsolete. The
          // drain splits a chunk on target errors, so a change obsoletes only
          // its own evaluation and its siblings still publish.
          if (!evidenceObsolete(error)) throw error;
          if (ids.length > 1)
            throw new JobTargetError(errorMessage(error), { cause: error });
          published = [];
          publications.push({
            evaluationId: ids[0]!,
            state: "obsolete",
            receipt: { reason: errorMessage(error) },
          });
          ready = [];
        }
        if (
          ready.length &&
          (published.length !== ids.length ||
            new Set(published.map((entry) => entry.evaluationId)).size !==
              ids.length ||
            published.some((entry) => !validIds.has(entry.evaluationId)))
        )
          throw new Error(
            "AI page adapter returned an unexpected publication set",
          );
        publications.push(...published);
      }
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
      await fenceAiEvaluationPage(
        tx,
        ready.map(({ target }) => target),
      );
    },
    async exhaust(tx, items, error) {
      await failAiEvaluations(
        tx,
        items.map((item) => item.ref),
        error,
      );
    },
  });
}

/** Product and connection features page; other features run item by item. */
export function aiEvaluationJobHandler(
  ports: AiEvaluationPorts = {},
): JobHandler {
  const paged = aiEvaluationDrainSpec(ports, true);
  const single = aiEvaluationDrainSpec(ports, false);
  return {
    prepare: (db, claim, context) =>
      (PAGE_FEATURES.has(claim.key.slice("ai-evaluation:".length))
        ? paged
        : single
      ).prepare(db, claim, context),
  };
}

import {
  suggestionProjectionTargets,
  suggestionSubjects,
} from "@cubby/schemas/suggestion";
import { createLogger } from "@cubby/worker-tracing";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import {
  advisoryLockKey,
  advisoryXactLockSequence,
} from "~/server/db/advisory-lock";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { suggestionTable } from "~/server/db/schema";
import type { StatementSuggestionScope } from "~/server/domains/transaction-import/repo/statement-input";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { findPgError } from "~/server/errors/db-errors";
import { recordAutomaticFeedbacks } from "~/server/generic/suggestions/repo/suggestion";
import { decisionForOperation } from "~/server/generic/suggestions/repo/suggestion-decisions";
import { suggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import { reviewKey } from "~/server/generic/suggestions/repo/suggestion-presentation";
import type { ReviewFamily } from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import {
  suggestionStateColumns,
  transitionSuggestionStates,
  type SuggestionStateRow,
} from "~/server/generic/suggestions/repo/suggestion-state";

import {
  type AutomaticBatchEntry,
  type AutomaticReview,
  automaticReviewInput,
  type Review,
} from "./review";
import {
  assertReviewAction,
  planApplicableState,
  planReviewInput,
  type Prediction,
} from "./review-plan";

const log = createLogger("automatic-rules");

/**
 * A page spends at most this many attempts on serialization failures or
 * deadlocks: the whole page, then each half once. A smaller boundary reads
 * less and conflicts less; replaying the same boundary repeats its conflict.
 */
const PAGE_ATTEMPTS = 3;

export type AutomaticPageItem = {
  suggestionId: string;
  operationId: string;
  expectedFingerprint: string;
  application: Review["application"];
  rule: AutomaticReview["rule"];
};

/**
 * `fallback` wrote nothing and keeps its own review; `retry` wrote nothing
 * because another item diverged after its writes, so it is admitted again in a
 * fresh transaction; `unfinished` exhausted the page's conflict replays.
 */
export type AutomaticPageOutcome =
  | "applied"
  | "fallback"
  | "out_of_scope"
  | "retry"
  | "unfinished";

/**
 * A family batch hook throws this after its writes began when one entry's
 * current plan diverged from what it admitted: the savepoint releases every
 * write, that entry keeps its own review and the rest are admitted again.
 */
export class AutomaticBatchDivergence extends Error {
  constructor(
    readonly suggestionId: string,
    message: string,
  ) {
    super(message);
    this.name = "AutomaticBatchDivergence";
  }
}

const replayable = (error: unknown) =>
  ["40001", "40P01"].includes(findPgError(error)?.code ?? "");

/**
 * Apply one family's automatic reviews together, as {@link reviewSuggestion}
 * applies one: the page fences once, enforces the statement scope once and
 * takes every review lock, the family's parent locks and the Suggestion row
 * locks once each, in that namespace order and sorted within each. The
 * family's `applyBatch` writes what it accepts; this owns Feedback and the
 * duplicate retirement. A `fallback` item wrote nothing and keeps the
 * single-review path. A write error rolls the applications back to a
 * savepoint: a typed {@link AutomaticBatchDivergence} falls back only its item
 * and leaves the rest to `retry`, any other error falls every item back. A
 * serialization failure or deadlock replays the page once as two halves
 * (settle stays with the first); a boundary that still conflicts ends
 * `unfinished`, and a lone item or settle replays up to the same attempt
 * budget. Operation ids are fixed per item, so a replayed page is idempotent.
 *
 * `settle` runs last in the same boundary with its own ids locked and
 * scope-checked alongside the reviews, receiving the admitted rows and the
 * locked ids the scope excludes; it must not write before the reviews.
 */
export async function reviewAutomaticPage<T>(
  db: Database,
  name: ReviewFamily,
  context: EntityKernelContext,
  items: readonly AutomaticPageItem[],
  options: {
    statementScope?: StatementSuggestionScope;
    settle?: {
      ids: readonly string[];
      run: (
        tx: Database,
        rows: ReadonlyMap<string, SuggestionStateRow>,
        outside: ReadonlySet<string>,
      ) => Promise<T>;
    };
  } = {},
): Promise<{
  outcomes: Map<string, AutomaticPageOutcome>;
  settled: T | null;
}> {
  const family = suggestionFamilies[name];
  const handler = family.applyBatch;
  const fallback = () => ({
    outcomes: new Map(
      items.map((item) => [item.suggestionId, "fallback" as const]),
    ),
    settled: null,
  });
  if (
    !handler ||
    family.afterApply ||
    family.applicationKey ||
    family.transactionBound === false ||
    new Set(items.map((item) => item.suggestionId)).size !== items.length
  )
    return fallback();
  const { assertAutomaticRuleOn } =
    await import("~/server/generic/suggestions/repo/automatic-application");
  const { assertWorkflowEffect, isWorkflowInterrupted } =
    await import("~/server/workflows/runs/execution");
  const page = async (
    tx: Database,
    items: readonly AutomaticPageItem[],
    settle: typeof options.settle,
  ) => {
    await assertWorkflowEffect(tx);
    const outcomes = new Map<string, AutomaticPageOutcome>();
    const settleIds = settle?.ids ?? [];
    const ids = [
      ...new Set([...items.map((item) => item.suggestionId), ...settleIds]),
    ];
    let admitted: ReadonlySet<string> | null = null;
    if (options.statementScope) {
      const { statementLabelTargetsInScope } =
        await import("~/server/domains/transaction-import/repo/statement-suggestions");
      admitted = await statementLabelTargetsInScope(
        tx,
        options.statementScope,
        ids,
      );
    }
    const reviews: { item: AutomaticPageItem; input: Review }[] = [];
    for (const item of items) {
      if (admitted && !admitted.has(item.suggestionId)) {
        outcomes.set(item.suggestionId, "out_of_scope");
        continue;
      }
      try {
        assertAutomaticRuleOn(item.rule.key, item.rule.stamp);
      } catch {
        // SILENT: the single-review path reports a policy change per item.
        outcomes.set(item.suggestionId, "fallback");
        continue;
      }
      reviews.push({
        item,
        input: automaticReviewInput.parse({
          suggestionId: item.suggestionId,
          operationId: item.operationId,
          verdict: "correct",
          correction: { present: false },
          intent: "apply",
          expectedFingerprint: item.expectedFingerprint,
          reason: null,
          evidence: null,
          ...(item.application && { application: item.application }),
        }),
      });
    }
    const predictions = new Map<string, Prediction>(
      reviews.length
        ? (
            await getDb(tx)
              .select({
                id: suggestionTable.id,
                fingerprint: suggestionTable.fingerprint,
                family: suggestionTable.family,
                subject: suggestionTable.subject,
                judgment: suggestionTable.judgment,
                producer: suggestionTable.producer,
                evidence: sql`NULL`,
              })
              .from(suggestionTable)
              .where(
                inArray(
                  suggestionTable.id,
                  reviews.map(({ item }) => item.suggestionId),
                ),
              )
          ).map((row) => [row.id, row])
        : [],
    );
    const planned = reviews.flatMap(({ item, input }) => {
      const prediction = predictions.get(item.suggestionId);
      try {
        if (prediction?.family !== name || !prediction.subject)
          throw new Error("Suggestion is not this family's");
        (family.subject ?? suggestionSubjects[name]).parse(prediction.subject);
        assertReviewAction(name, input.verdict, {
          authority: "automatic",
          rule: item.rule,
        });
        return [
          { item, prediction, input: planReviewInput(input, prediction) },
        ];
      } catch {
        // SILENT: the single-review path refuses this item with its own error.
        outcomes.set(item.suggestionId, "fallback");
        return [];
      }
    });
    await advisoryXactLockSequence(getDb(tx), [
      // An apply supersedes the subject's other live rows; every subject lock
      // precedes every id lock, as each single review takes subject then id.
      planned.map(({ prediction }) =>
        advisoryLockKey(
          "suggestion-review",
          `${prediction.family}:${JSON.stringify(prediction.subject)}`,
        ),
      ),
      planned.map(({ prediction }) =>
        advisoryLockKey("suggestion-review", prediction.id),
      ),
      handler.lockKeys(planned.map(({ prediction }) => prediction)),
    ]);
    const locked = new Map(
      (ids.length
        ? await getDb(tx)
            .select(suggestionStateColumns)
            .from(suggestionTable)
            .where(inArray(suggestionTable.id, ids))
            .orderBy(suggestionTable.id)
            .for("update")
        : []
      ).map((row) => [row.id, row]),
    );
    const entries: (AutomaticBatchEntry & { item: AutomaticPageItem })[] = [];
    for (const { item, prediction, input } of planned) {
      const state = locked.get(item.suggestionId);
      try {
        const applicable = planApplicableState(state);
        // A receipt or review under this operation is a replay; the single
        // review path verifies and returns it.
        if (
          decisionForOperation(
            applicable.id,
            applicable.decisions ?? [],
            `command-application:${input.operationId}`,
          ) ||
          decisionForOperation(
            applicable.id,
            applicable.decisions ?? [],
            input.operationId,
          ) ||
          input.expectedFingerprint !==
            reviewKey({
              suggestionId: applicable.id,
              fingerprint: applicable.fingerprint,
            })
        )
          throw new Error("Suggestion changed since selection");
        (family.target ?? suggestionProjectionTargets[name]).parse(applicable);
        entries.push({ item, state: applicable, prediction, input });
      } catch {
        // SILENT: the single-review path reports the stale or resolved state.
        outcomes.set(item.suggestionId, "fallback");
      }
    }
    if (entries.length) {
      try {
        await withTransactionDatabase(tx, async (savepoint) => {
          const results = await handler.apply(
            savepoint,
            { ...context, db: savepoint },
            entries,
            { authority: "automatic", statementScope: options.statementScope },
          );
          const applied = entries.filter(
            (_, index) => results[index] === "applied",
          );
          for (const [index, entry] of entries.entries())
            outcomes.set(entry.item.suggestionId, results[index] ?? "fallback");
          if (!applied.length) return;
          const actorUserId = context.actorContext.userId;
          const reviewsRecorded = await recordAutomaticFeedbacks(
            savepoint,
            applied.map(({ input, item }) => ({
              ...input,
              suggestionId: item.suggestionId,
              authority: "automatic",
              actorUserId,
              metadata: {
                kind: "assessment_review",
                application: input.application ?? null,
                expectedFingerprint: input.expectedFingerprint ?? null,
                rule: item.rule,
              },
            })),
          );
          // The apply settled each subject; another live row for it is a
          // duplicate whose apply would write the same thing twice.
          await transitionSuggestionStates(
            savepoint,
            and(
              eq(suggestionTable.family, name),
              family.liveSubjectRows
                ? family.liveSubjectRows(
                    applied.map(({ prediction }) => prediction.subject),
                  )
                : sql`${suggestionTable.subject} = ANY(${textArrayParam(
                    applied.map(({ prediction }) =>
                      JSON.stringify(prediction.subject),
                    ),
                  )}::jsonb[])`,
              notInArray(
                suggestionTable.id,
                applied.map(({ item }) => item.suggestionId),
              ),
              eq(suggestionTable.active, true),
              eq(suggestionTable.status, "pending"),
            ),
            { active: false, status: "superseded" },
          );
          await recordAutomaticFeedbacks(
            savepoint,
            applied.map(({ input, item }, index) => {
              const event = reviewsRecorded[index]!;
              return {
                suggestionId: item.suggestionId,
                operationId: `command-application:${input.operationId}`,
                verdict: "ungraded",
                intent: "apply",
                authority: "automatic",
                actorUserId,
                receipt: {
                  suggestionId: item.suggestionId,
                  feedbackId: event.id,
                  status: "applied",
                  applied: true,
                },
                metadata: {
                  kind: "assessment_application",
                  commandFeedbackId: event.id,
                  rule: item.rule,
                },
              };
            }),
          );
        });
      } catch (error) {
        if (isWorkflowInterrupted(error) || replayable(error)) throw error;
        // The savepoint released every application. A named divergence keeps
        // only its item for its own review; anything else retries each alone.
        const diverged =
          error instanceof AutomaticBatchDivergence ? error.suggestionId : null;
        log.warn("Automatic rule page fell back", {
          items: entries.length,
          diverged: diverged !== null,
          error: scrubErrorMessage(String(error)),
        });
        for (const entry of entries)
          outcomes.set(
            entry.item.suggestionId,
            diverged === null || entry.item.suggestionId === diverged
              ? "fallback"
              : "retry",
          );
      }
    }
    const settled = settle
      ? await settle.run(
          tx,
          new Map(
            settle.ids.flatMap((id) => {
              const row = locked.get(id);
              return row && (!admitted || admitted.has(id)) ? [[id, row]] : [];
            }),
          ),
          new Set(
            settle.ids.filter(
              (id) => locked.has(id) && admitted && !admitted.has(id),
            ),
          ),
        )
      : null;
    return { outcomes, settled };
  };
  const attempt = async (
    boundary: readonly AutomaticPageItem[],
    settle: typeof options.settle,
  ) => {
    try {
      return await withTransactionDatabase(
        db,
        (tx) => page(tx, boundary, settle),
        { isolationLevel: "serializable" },
      );
    } catch (error) {
      if (isWorkflowInterrupted(error) || !replayable(error)) throw error;
      log.warn("Automatic rule page conflicted", {
        items: boundary.length,
        sqlState: findPgError(error)?.code,
        detail: scrubErrorMessage(findPgError(error)?.detail ?? ""),
      });
      return null;
    }
  };
  const unfinished = (boundary: readonly AutomaticPageItem[]) =>
    new Map(boundary.map((item) => [item.suggestionId, "unfinished" as const]));
  const whole = await attempt(items, options.settle);
  if (whole) return whole;
  if (items.length > 1) {
    const middle = Math.ceil(items.length / 2);
    const first = await attempt(items.slice(0, middle), options.settle);
    const second = await attempt(items.slice(middle), undefined);
    return {
      outcomes: new Map([
        ...(first?.outcomes ?? unfinished(items.slice(0, middle))),
        ...(second?.outcomes ?? unfinished(items.slice(middle))),
      ]),
      settled: first?.settled ?? null,
    };
  }
  for (let attempts = 1; attempts < PAGE_ATTEMPTS; attempts++) {
    const replay = await attempt(items, options.settle);
    if (replay) return replay;
  }
  return { outcomes: unfinished(items), settled: null };
}

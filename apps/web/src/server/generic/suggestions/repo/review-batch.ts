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

/** A page replays a serialization failure or deadlock this many times. */
const PAGE_ATTEMPTS = 3;

export type AutomaticPageItem = {
  suggestionId: string;
  operationId: string;
  expectedFingerprint: string;
  application: Review["application"];
  rule: AutomaticReview["rule"];
};

export type AutomaticPageOutcome = "applied" | "fallback" | "out_of_scope";

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
 * savepoint and falls every item back; a serialization failure or deadlock
 * splits the page in half (settle stays with the first half), and a single
 * item replays, then falls back. Operation ids are fixed per item, so a
 * replayed page is idempotent.
 *
 * `settle` runs last in the same boundary with its own ids locked and
 * scope-checked alongside the reviews; it must not write before the reviews.
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
  const page = async (tx: Database) => {
    await assertWorkflowEffect(tx);
    const outcomes = new Map<string, AutomaticPageOutcome>();
    const settleIds = options.settle?.ids ?? [];
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
        const applicable = planApplicableState(state, prediction.family);
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
              sql`${suggestionTable.subject} = ANY(${textArrayParam(
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
        // The savepoint released every application; each item retries alone
        // and reports its own refusal.
        log.warn("Automatic rule page fell back to single applications", {
          items: entries.length,
          error: scrubErrorMessage(String(error)),
        });
        for (const entry of entries)
          outcomes.set(entry.item.suggestionId, "fallback");
      }
    }
    const settled = options.settle
      ? await options.settle.run(
          tx,
          new Map(
            options.settle.ids.flatMap((id) => {
              const row = locked.get(id);
              return row && (!admitted || admitted.has(id)) ? [[id, row]] : [];
            }),
          ),
        )
      : null;
    return { outcomes, settled };
  };
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransactionDatabase(db, page, {
        isolationLevel: "serializable",
      });
    } catch (error) {
      if (isWorkflowInterrupted(error) || !replayable(error)) throw error;
      log.warn("Automatic rule page conflicted", {
        attempt,
        items: items.length,
        sqlState: findPgError(error)?.code,
      });
      if (items.length > 1) {
        // A smaller boundary reads fewer pages and conflicts less; replaying
        // the whole page repeats the same conflict.
        const middle = Math.ceil(items.length / 2);
        const first = await reviewAutomaticPage(
          db,
          name,
          context,
          items.slice(0, middle),
          options,
        );
        const second = await reviewAutomaticPage(
          db,
          name,
          context,
          items.slice(middle),
          { statementScope: options.statementScope },
        );
        return {
          outcomes: new Map([...first.outcomes, ...second.outcomes]),
          settled: first.settled,
        };
      }
      if (attempt >= PAGE_ATTEMPTS) return fallback();
    }
  }
}

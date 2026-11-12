import { suggestionStatus } from "@cubby/schemas/ai";
import { type AutomaticRuleKey } from "@cubby/schemas/automatic-rule";
import { systemActor } from "@cubby/schemas/context";
import { runEntityId } from "@cubby/schemas/identifiers";
import { suggestionFamily } from "@cubby/schemas/suggestion";
import { createLogger } from "@cubby/worker-tracing";
import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  describeErrorCauses,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import type { StatementSuggestionScope } from "~/server/domains/transaction-import/repo/statement-input";
import type {
  EntityKernelContext,
  KernelServicesFor,
} from "~/server/entity-kernel/adapter";
import { isSerializationFailure } from "~/server/errors/db-errors";
import {
  AUTOMATIC_RULES,
  ruleBase,
} from "~/server/generic/suggestions/repo/automatic-policy";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import {
  type AutomaticPageOutcome,
  reviewAutomaticPage,
} from "~/server/generic/suggestions/repo/review-batch";
import { matchedRulesOf } from "~/server/generic/suggestions/repo/suggestion";
import { suggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import { reviewKey } from "~/server/generic/suggestions/repo/suggestion-presentation";
import { isReviewFamily } from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import type { SuggestionStateRow } from "~/server/generic/suggestions/repo/suggestion-state";

const log = createLogger("automatic-rules");

const ruleStamps = z
  .object({ matchedRules: z.array(z.string()).default([]) })
  .passthrough();

/** Policy is fixed code; a stamp from another revision cannot authorize an application. */
export function assertAutomaticRuleOn(key: AutomaticRuleKey, stamp: string) {
  if (stamp !== ruleBase(key))
    throw new Error("Automatic policy changed; refresh the suggestion");
}

type Candidate = {
  id: string;
  family: string;
  status: string;
  active: boolean;
  data: unknown;
  entity: string;
  field: string;
  kind: string;
  confidence: number;
  model: string;
  fingerprint: string | null;
  runId: string | null;
  judgment: unknown;
};

export type AutomaticRuleOutcome = {
  applied: string[];
  refused: { suggestionId: string; message: string }[];
};

/**
 * The rule an automatic pass applies to `row` now, with its fixed review, or
 * null when none applies. A match must hold both now and in its publication
 * stamp, so evidence that drifted since publication is never applied.
 */
export function selectAutomaticRule(
  row: Candidate,
  options: { importClean?: boolean },
) {
  if (!row.active || row.status !== "pending") return null;
  const family = suggestionFamily.safeParse(row.family);
  if (!family.success || !isReviewFamily(family.data)) return null;
  const name = family.data;
  const policy = suggestionFamilies[name].automatic;
  if (!policy) return null;
  const stamp = ruleStamps.safeParse(row.data).data;
  if (policy.requiresStamp && !stamp?.matchedRules.length) return null;
  const [match] = policy
    .match(row)
    .filter(
      (match) =>
        (!policy.requiresStamp || stamp?.matchedRules.includes(match.stamp)) &&
        (AUTOMATIC_RULES[match.key].execution !== "import_clean" ||
          options.importClean === true),
    )
    .sort(
      (a, b) =>
        Number(AUTOMATIC_RULES[b.key].execution === "import_clean") -
        Number(AUTOMATIC_RULES[a.key].execution === "import_clean"),
    );
  if (!match) return null;
  return {
    row,
    name,
    policy,
    match,
    review: {
      suggestionId: row.id,
      operationId: `automatic:${match.key}@${match.revision}:${row.id}`,
      expectedFingerprint: reviewKey({
        suggestionId: row.id,
        fingerprint: row.fingerprint,
      }),
      application: policy.application?.(row),
      rule: { key: match.key, revision: match.revision, stamp: match.stamp },
    },
  };
}

export type AutomaticSelection = NonNullable<
  ReturnType<typeof selectAutomaticRule>
>;

/** Each listed Suggestion's current automatic selection, by id. */
export async function selectAutomaticRules(
  db: Database,
  suggestionIds: readonly string[],
  options: { importClean?: boolean },
) {
  const selections = new Map<string, AutomaticSelection>();
  if (!suggestionIds.length) return selections;
  const rows = await unwrapDb(db).execute<Candidate>(
    sql`
    SELECT s.id, s.family, s.status, s.active, s.data, s.entity, s.field,
      s.kind, s.confidence, s.model, s.fingerprint, s."runId", s.judgment
    FROM "Suggestion" s
    WHERE s.id = ANY(${uuidArrayParam(suggestionIds)})
  `,
    "objects",
  );
  for (const row of rows) {
    const selection = selectAutomaticRule(row, options);
    if (selection) selections.set(row.id, selection);
  }
  return selections;
}

type AutomaticContext = EntityKernelContext | KernelServicesFor;

const baseContext = (
  db: Database,
  supplied: AutomaticContext,
): EntityKernelContext =>
  typeof supplied === "function"
    ? { ...supplied(db), db, actorContext: systemActor() }
    : supplied;

/** The system actor's context for one selection's run and authority. */
function automaticContext(
  db: Database,
  base: EntityKernelContext,
  selection: AutomaticSelection,
): EntityKernelContext {
  return {
    ...base,
    db,
    actorContext: {
      ...systemActor(),
      runId: selection.row.runId
        ? runEntityId.parse(selection.row.runId)
        : null,
      // Only Cubby's own field values are revisable; statement booking is
      // import evidence and stays protected.
      ...(selection.policy.authority && {
        authority: selection.policy.authority,
      }),
    },
  };
}

/**
 * Applies each pending Suggestion that matches a rule that is on, through
 * `reviewSuggestion` and its family's full apply path (fingerprint recheck,
 * applied-first state, one transaction), as the system actor. Replays are
 * idempotent: an applied Suggestion is no longer pending, and the operation
 * id is fixed per rule revision and Suggestion.
 */
export async function applyAutomaticRules(
  db: Database,
  suggestionIds: readonly string[],
  options: {
    /**
     * Kernel services for field writes, or a factory that builds them for
     * `db`; the actor is always the system's.
     */
    context: AutomaticContext;
    onFailure?: (suggestionId: string, message: string) => void;
    /** An import authorizes automatic clean spending plans. */
    importClean?: boolean;
    /** Selection constraints survive regeneration and are rechecked by write admission. */
    statementScope?: StatementSuggestionScope;
  },
): Promise<AutomaticRuleOutcome> {
  const outcome: AutomaticRuleOutcome = { applied: [], refused: [] };
  const selections = await selectAutomaticRules(db, suggestionIds, options);
  // Built on first application so a pass with nothing to apply builds nothing.
  let base: EntityKernelContext | undefined;
  for (const selection of selections.values()) {
    const { row, policy, review } = selection;
    try {
      base ??= baseContext(db, options.context);
      const context = automaticContext(db, base, selection);
      // Ineligible or stale field work stays reviewable/refreshable without
      // reporting an expected policy hold as an application error every pass.
      if (policy.canApply && !(await policy.canApply(db, context, row.id)))
        continue;
      await reviewSuggestion(
        db,
        context,
        {
          suggestionId: row.id,
          operationId: review.operationId,
          verdict: "correct",
          correction: { present: false },
          intent: "apply",
          expectedFingerprint: review.expectedFingerprint,
          reason: null,
          evidence: null,
          ...(review.application && { application: review.application }),
        },
        {
          authority: "automatic",
          statementScope: options.statementScope,
          rule: review.rule,
        },
      );
      outcome.applied.push(row.id);
    } catch (error) {
      // Preflight runs before review's savepoint. Its serialization failure may
      // abort the caller's transaction, whose owner must receive the replay signal.
      if (isSerializationFailure(error)) throw error;
      if (
        (
          await import("~/server/workflows/runs/execution")
        ).isWorkflowInterrupted(error)
      )
        throw error;
      // A refusal leaves the suggestion pending for review, which is the
      // rule's safe outcome; the raw reason is returned and logged.
      const message = scrubErrorMessage(
        JSON.stringify(describeErrorCauses(error)),
      );
      outcome.refused.push({ suggestionId: row.id, message });
      options.onFailure?.(row.id, message);
      log.warn("Automatic rule application refused", {
        suggestionId: row.id,
        rule: review.rule.stamp,
        error: message,
      });
    }
  }
  return outcome;
}

/**
 * Apply a page of selections in one transaction through the family's batch
 * hook. A selection the page cannot share a context with (another family or
 * run, a field authority or an eligibility check) comes back as `fallback`,
 * like any item the page declined; the caller applies those alone.
 */
export async function applyAutomaticRulePage<T>(
  db: Database,
  selections: readonly AutomaticSelection[],
  options: {
    context: AutomaticContext;
    statementScope?: StatementSuggestionScope;
    settle?: {
      ids: readonly string[];
      run: (
        tx: Database,
        rows: ReadonlyMap<string, SuggestionStateRow>,
      ) => Promise<T>;
    };
  },
): Promise<{
  outcomes: Map<string, AutomaticPageOutcome>;
  settled: T | null;
}> {
  const [first] = selections;
  if (!first && !options.settle) return { outcomes: new Map(), settled: null };
  const base = baseContext(db, options.context);
  const batchable = selections.filter(
    (selection) =>
      selection.name === first?.name &&
      selection.row.runId === first.row.runId &&
      !selection.policy.canApply &&
      !selection.policy.authority,
  );
  const page = await reviewAutomaticPage(
    db,
    first?.name ?? suggestionFamily.enum.statement_transaction,
    first ? automaticContext(db, base, first) : base,
    batchable.map(({ review }) => review),
    { statementScope: options.statementScope, settle: options.settle },
  );
  for (const selection of selections)
    if (!page.outcomes.has(selection.row.id))
      page.outcomes.set(selection.row.id, "fallback");
  return page;
}

/** After decision labels publish a charge: its current pending suggestion. */
export async function applyAutomaticRulesForCharge(
  db: Database,
  charge: { source: string; chargeKey: string },
  servicesFor: KernelServicesFor,
  importClean = false,
  statementScope?: StatementSuggestionScope,
) {
  const rows = await unwrapDb(db).execute<{ id: string }>(
    sql`
    SELECT id FROM "Suggestion"
    WHERE family = ${sqlEnumConstant(suggestionFamily, suggestionFamily.enum.statement_transaction)} AND active
      AND status = ${suggestionStatus.enum.pending}
      AND data->>${sql.raw("'source'")} = ${charge.source} AND data->>${sql.raw("'chargeKey'")} = ${charge.chargeKey}
      AND jsonb_array_length(${matchedRulesOf(sql`data`)}) > 0
  `,
    "objects",
  );
  return applyAutomaticRules(
    db,
    rows.map((row) => row.id),
    { context: servicesFor, importClean, statementScope },
  );
}

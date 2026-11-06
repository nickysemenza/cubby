import { suggestionStatus } from "@cubby/schemas/ai";
import { type AutomaticRuleKey } from "@cubby/schemas/automatic-rule";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { runEntityId } from "@cubby/schemas/identifiers";
import { statementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
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
import { systemActor } from "~/server/domains/run/repo/ensure-run";
import type { StatementSuggestionScope } from "~/server/domains/transaction-import/repo/statement-input";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  AUTOMATIC_RULES,
  type AutomaticRuleMatch,
  matchFieldRules,
  matchStatementRules,
  ruleBase,
} from "~/server/generic/suggestions/repo/automatic-policy";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import { matchedRulesOf } from "~/server/generic/suggestions/repo/suggestion";
import { canAutomaticallyFillField } from "~/server/generic/suggestions/repo/suggestion-review";

const log = createLogger("automatic-rules");

const ruleStamps = z
  .object({ matchedRules: z.array(z.string()).default([]) })
  .passthrough();

/** Policy is fixed; old attach stamps cannot authorize an automatic application. */
export async function assertAutomaticRuleOn(
  _db: Database,
  key: AutomaticRuleKey,
  stamp: string,
  _suggestionId: string | null,
) {
  if (key === "statement_transaction.attach" || stamp !== ruleBase(key))
    throw new Error("Automatic policy changed; refresh the suggestion");
}

const shortcodeEntity = z.enum(shortcodeEntities);

type Candidate = {
  id: string;
  family: string;
  status: string;
  active: boolean;
  data: unknown;
  evidence: unknown;
  subject: unknown;
  entity: string;
  field: string;
  kind: string;
  confidence: number;
  model: string;
  fingerprint: string | null;
  runId: string | null;
  judgment: unknown;
};

function currentMatches(row: Candidate): AutomaticRuleMatch[] {
  if (row.family === "field") {
    const entity = shortcodeEntity.safeParse(row.entity);
    return entity.success
      ? matchFieldRules({
          entity: entity.data,
          field: row.field,
          kind: row.kind,
          confidence: row.confidence,
          model: row.model,
        })
      : [];
  }
  if (row.family === "statement_transaction") {
    const judgment = statementTransactionJudgment.safeParse(row.judgment);
    return judgment.success ? matchStatementRules(judgment.data) : [];
  }
  return [];
}

export type AutomaticRuleOutcome = {
  applied: string[];
  refused: { suggestionId: string; message: string }[];
};

/**
 * Applies each pending Suggestion that matches a rule that is on, through
 * `reviewSuggestion` and its family's full apply path (fingerprint recheck,
 * applied-first state, one transaction), as the system actor. A match must
 * hold both now and in its publication stamp, so evidence that drifted since
 * publication is never applied. Replays are idempotent: an applied
 * Suggestion is no longer pending, and the operation id is fixed per rule
 * revision and Suggestion.
 */
export async function applyAutomaticRules(
  db: Database,
  suggestionIds: readonly string[],
  options: {
    /** Kernel services for field writes; the actor is always the system's. */
    context?: EntityKernelContext;
    onFailure?: (suggestionId: string, message: string) => void;
    /** An import authorizes clean spending plans while their rule is enabled. */
    importClean?: boolean;
    /** Selection constraints survive regeneration and are rechecked by write admission. */
    statementScope?: StatementSuggestionScope;
  } = {},
): Promise<AutomaticRuleOutcome> {
  const outcome: AutomaticRuleOutcome = { applied: [], refused: [] };
  if (!suggestionIds.length) return outcome;
  const { rows } = await unwrapDb(db).execute<Candidate>(sql`
    SELECT s.id, s.family, s.status, s.active, s.data, s.entity, s.field,
      s.kind, s.confidence, s.model, s.fingerprint, s."runId", s.judgment, s.evidence, s.subject
    FROM "Suggestion" s
    WHERE s.id IN (${sql.join(
      suggestionIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `);
  let base = options.context;
  for (const row of rows) {
    if (!row.active || row.status !== "pending") continue;
    const stamp = ruleStamps.safeParse(row.data).data;
    if (row.family !== "field" && !stamp?.matchedRules.length) continue;
    const current = currentMatches(row);
    const matches = current
      .filter(
        (match) =>
          (row.family === "field" ||
            stamp?.matchedRules.includes(match.stamp)) &&
          (AUTOMATIC_RULES[match.key].execution !== "import_clean" ||
            options.importClean === true),
      )
      .sort(
        (a, b) =>
          Number(AUTOMATIC_RULES[b.key].execution === "import_clean") -
          Number(AUTOMATIC_RULES[a.key].execution === "import_clean"),
      );
    const [match] = matches;
    if (!match) continue;
    try {
      let application;
      if (!application && row.family === "statement_transaction") {
        const judgment = statementTransactionJudgment.parse(row.judgment);
        application = {
          kind: "statement_transaction" as const,
          action: judgment.recommended,
          fields: [],
          rejectedCandidateIds: [],
        };
      }
      base ??= {
        ...(await import("~/server/http/request-context")).buildCrudServices(
          db,
        ),
        db,
        actorContext: systemActor(),
      };
      const context: EntityKernelContext = {
        ...base,
        db,
        actorContext: {
          ...systemActor(),
          runId: row.runId ? runEntityId.parse(row.runId) : null,
        },
      };
      // Ineligible or stale field work stays reviewable/refreshable without
      // reporting an expected policy hold as an application error every pass.
      if (
        row.family === "field" &&
        !(await canAutomaticallyFillField(db, context, row.id))
      )
        continue;
      await reviewSuggestion(
        db,
        context,
        {
          suggestionId: row.id,
          operationId: `automatic:${match.key}@${match.revision}:${row.id}`,
          verdict: "correct",
          correction: { present: false },
          intent: "apply",
          expectedFingerprint: row.fingerprint,
          reason: null,
          evidence: null,
          ...(application && { application }),
        },
        {
          authority: "automatic",
          statementScope: options.statementScope,
          rule: {
            key: match.key,
            revision: match.revision,
            stamp: match.stamp,
          },
        },
      );
      outcome.applied.push(row.id);
    } catch (error) {
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
        rule: match.stamp,
        error: message,
      });
    }
  }
  return outcome;
}

/** After decision labels publish a charge: its current pending suggestion. */
export async function applyAutomaticRulesForCharge(
  db: Database,
  charge: { source: string; chargeKey: string },
  importClean = false,
  statementScope?: StatementSuggestionScope,
) {
  const { rows } = await unwrapDb(db).execute<{ id: string }>(sql`
    SELECT id FROM "Suggestion"
    WHERE family = ${suggestionFamily.enum.statement_transaction} AND active
      AND status = ${suggestionStatus.enum.pending}
      AND data->>${"source"} = ${charge.source} AND data->>${"chargeKey"} = ${charge.chargeKey}
      AND jsonb_array_length(${matchedRulesOf(sql`data`)}) > 0
  `);
  return applyAutomaticRules(
    db,
    rows.map((row) => row.id),
    { importClean, statementScope },
  );
}

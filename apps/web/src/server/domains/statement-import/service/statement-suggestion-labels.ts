import { assessmentSubjects } from "@cubby/schemas/assessment";
import { financialTransactionSettlementViolation } from "@cubby/schemas/financial-transaction";
import type { RunId } from "@cubby/schemas/identifiers";
import {
  statementTransactionJudgment,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import { selectDecisionModel } from "@cubby/shared/ai/models";

import {
  decisionChoiceFitsContext,
  type DecisionPort,
  runDecisionChoice,
} from "~/server/ai/decision-model";
import {
  STATEMENT_CHARGE_IDENTITY_FEATURE,
  STATEMENT_TRANSACTION_KIND_FEATURE,
} from "~/server/ai/policy/features";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import {
  buildChargeProposals,
  isClean,
  labelledProposal,
  publishChargeProposal,
  suggestionsNeedingLabels,
} from "~/server/domains/statement-import/repo/statement-suggestions";

/** One queue message labels at most this many suggestions. */
const STATEMENT_LABEL_BATCH = 20;

const identityLabel = {
  same_charge: "same",
  different_charge: "different",
  insufficient_evidence: "insufficient",
} as const;

/**
 * Label pending rule suggestions with the decision model: whether each attach
 * candidate is the same charge, and the kind no provider category decided.
 * Labels are advisory; they only decide whether a suggestion is
 * bulk-acceptable. Respects the automatic-work switch that gates AI refresh.
 */
export async function labelStatementSuggestions(
  db: Database,
  input: { limit?: number; port?: DecisionPort; runId?: RunId | null } = {},
): Promise<{ labelled: number; remaining: boolean }> {
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled && !input.port)
    return { labelled: 0, remaining: false };
  const limit = input.limit ?? STATEMENT_LABEL_BATCH;
  const rows = await suggestionsNeedingLabels(db, limit + 1);
  if (!rows.length) return { labelled: 0, remaining: false };
  const runId =
    input.runId ??
    (await ensureRun(db, systemActor(), { purpose: "background" }));
  let labelled = 0;
  for (const row of rows.slice(0, limit)) {
    const subject = assessmentSubjects.statement_transaction.parse(row.subject);
    const charge = { source: subject.source, chargeKey: subject.chargeKey };
    const [current] = await buildChargeProposals(db, [charge]);
    // Stale evidence waits for the next generation pass to republish it.
    if (!current || current.evidenceFingerprint !== row.evidenceFingerprint)
      continue;
    const model = selectDecisionModel({ key: subject.chargeKey });
    const usage = { db, runId, operation: "statement-suggestion-label" };
    const judgment: StatementTransactionJudgment = structuredClone(
      current.judgment,
    );
    const statement = {
      descriptor: current.canonical.rawDescription,
      merchant: current.canonical.merchant,
      category: current.canonical.sourceCategory,
      date: current.canonical.statementDate,
      amount: current.canonical.amount,
      status: judgment.providerStatus,
    };
    for (const candidate of judgment.candidates) {
      const prompt = STATEMENT_CHARGE_IDENTITY_FEATURE.prompt(
        JSON.stringify({
          statement,
          transaction: {
            descriptor: candidate.rawDescription,
            merchant: candidate.merchant,
            date: candidate.postedDate ?? candidate.transactionDate,
            amount: candidate.amount,
            status: candidate.status,
          },
        }),
      );
      if (!decisionChoiceFitsContext(prompt)) continue;
      const result = await runDecisionChoice({
        ...prompt,
        feature: STATEMENT_CHARGE_IDENTITY_FEATURE,
        decisionModel: model,
        port: input.port,
        usage,
      });
      const choice =
        STATEMENT_CHARGE_IDENTITY_FEATURE.choices[result.selectedIndex ?? -1];
      candidate.label = {
        same: choice ? identityLabel[choice] : "insufficient",
        confidence: result.confidence,
        model,
      };
    }
    if (judgment.create?.kindSource === "sign") {
      const prompt = STATEMENT_TRANSACTION_KIND_FEATURE.prompt(
        JSON.stringify(statement),
      );
      if (decisionChoiceFitsContext(prompt)) {
        const result = await runDecisionChoice({
          ...prompt,
          feature: STATEMENT_TRANSACTION_KIND_FEATURE,
          decisionModel: model,
          port: input.port,
          usage,
        });
        const kind =
          STATEMENT_TRANSACTION_KIND_FEATURE.choices[
            result.selectedIndex ?? -1
          ];
        // Only a confident answer replaces the direction's default; either way
        // a model kind stays a correction-reviewed choice, never bulk-accepted.
        // A kind the settlement sign rule refuses could never be applied.
        if (
          kind &&
          result.confidence === "high" &&
          !financialTransactionSettlementViolation({
            linked: false,
            kind,
            amount: judgment.create.amount,
          })
        )
          judgment.create = { ...judgment.create, kind, kindSource: "model" };
      }
    }
    judgment.clean = isClean(judgment, current.canonical.amount);
    const outcome = await publishChargeProposal(
      db,
      await labelledProposal(
        current,
        statementTransactionJudgment.parse(judgment),
      ),
      {
        kind: "model",
        model,
        revision: STATEMENT_CHARGE_IDENTITY_FEATURE.promptVersion,
        runId,
        evaluationId: null,
      },
    );
    if (outcome === "published") labelled++;
  }
  // A page of only stale suggestions stops the chain; regeneration resumes it.
  return { labelled, remaining: rows.length > limit && labelled > 0 };
}

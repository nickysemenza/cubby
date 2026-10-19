import { assessmentSubjects } from "@cubby/schemas/assessment";
import type { RunId } from "@cubby/schemas/identifiers";
import type { RunStepError } from "@cubby/schemas/run-step";
import {
  statementTransactionJudgment,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import { selectDecisionModel } from "@cubby/shared/ai/models";

import { AiBudgetExhaustedError } from "~/server/ai/budget";
import {
  decisionChoiceFitsContext,
  type DecisionPort,
  runDecisionChoice,
} from "~/server/ai/decision-model";
import { STATEMENT_CHARGE_IDENTITY_FEATURE } from "~/server/ai/policy/features";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import {
  buildChargeProposals,
  isClean,
  labelledProposal,
  publishChargeProposal,
  suggestionsNeedingLabels,
  type LabelCursor,
} from "~/server/domains/statement-import/repo/statement-suggestions";
import { labelStatementKind } from "~/server/domains/statement-import/service/statement-kind-labels";
import { applyAutomaticRulesForCharge } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

/** One label page labels at most this many suggestions. */
const STATEMENT_LABEL_BATCH = 20;

const identityLabel = {
  same_charge: "same",
  different_charge: "different",
  insufficient_evidence: "insufficient",
} as const;

/**
 * Label pending rule suggestions with the decision model: whether each attach
 * candidate is the same charge, and every create's kind and counterparty.
 * Labels are advisory; they only decide whether a suggestion is
 * bulk-acceptable. Respects the automatic-work switch that gates AI refresh.
 */
export async function labelStatementSuggestions(
  db: Database,
  input: {
    limit?: number;
    port?: DecisionPort;
    /** The Run the model calls are accounted to (a Sweep's step). */
    runId?: RunId | null;
    after?: LabelCursor | null;
    /** Label only this import's charges (an import-scoped Sweep). */
    importId?: string | null;
  } = {},
): Promise<{
  labelled: number;
  /** Suggestions whose evidence moved since publication; regeneration relabels them. */
  stale: number;
  failed: RunStepError[];
  next: LabelCursor | null;
  /** False when the automatic-work switch is off, so nothing was asked. */
  active: boolean;
}> {
  const empty = { labelled: 0, stale: 0, failed: [], next: null };
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled && !input.port) return { ...empty, active: false };
  const limit = input.limit ?? STATEMENT_LABEL_BATCH;
  const rows = await suggestionsNeedingLabels(
    db,
    limit + 1,
    input.after,
    input.importId ?? null,
  );
  if (!rows.length) return { ...empty, active: true };
  const runId =
    input.runId ??
    (await ensureRun(db, systemActor(), { purpose: "background" }));
  let labelled = 0;
  let stale = 0;
  const failed: RunStepError[] = [];
  const page = rows.slice(0, limit);
  for (const row of page) {
    try {
      const subject = assessmentSubjects.statement_transaction.parse(
        row.subject,
      );
      const charge = { source: subject.source, chargeKey: subject.chargeKey };
      const [current] = await buildChargeProposals(db, [charge]);
      // Stale evidence waits for the next generation pass to republish it.
      if (!current || current.evidenceFingerprint !== row.evidenceFingerprint) {
        stale++;
        continue;
      }
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
      if (judgment.create)
        judgment.create = await labelStatementKind(judgment.create, {
          subject: JSON.stringify(statement),
          transfer: judgment.transfer,
          model,
          port: input.port,
          usage,
        });
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
      if (outcome === "published") {
        labelled++;
        await applyAutomaticRulesForCharge(db, charge);
      }
    } catch (error) {
      // The budget pauses the whole pass; any other failure is this charge's.
      if (error instanceof AiBudgetExhaustedError) throw error;
      const subject = assessmentSubjects.statement_transaction.safeParse(
        row.subject,
      );
      failed.push({
        at: new Date().toISOString(),
        message: runFailureText(error instanceof Error ? error : String(error)),
        ...(subject.success && {
          ref: `charge:${subject.data.source}:${subject.data.chargeKey}`,
        }),
      });
    }
  }
  const last = page.at(-1);
  return {
    labelled,
    stale,
    failed,
    next:
      rows.length > limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
    active: true,
  };
}

import { assessmentSubjects } from "@cubby/schemas/assessment";
import type { RunId } from "@cubby/schemas/identifiers";
import type { RunStepError } from "@cubby/schemas/run-step";
import {
  statementTransactionJudgment,
  type StatementTransactionJudgment,
} from "@cubby/schemas/statement-suggestion";
import {
  selectDecisionModel,
  type SupportedDecisionModel,
} from "@cubby/shared/ai/models";

import { forEachConcurrently } from "~/lib/concurrency-limiter";
import { AiBudgetExhaustedError, settleDecisions } from "~/server/ai/budget";
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
  chargeId,
  type ChargeRef,
  isClean,
  labelledProposal,
  publishChargeProposal,
  regenerateCharges,
  STATEMENT_PUBLISH_CONCURRENCY,
  suggestionsNeedingLabels,
  type LabelCursor,
} from "~/server/domains/statement-import/repo/statement-suggestions";
import { labelStatementKind } from "~/server/domains/statement-import/service/statement-kind-labels";
import { applyAutomaticRulesForCharge } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

/** One label page labels at most this many suggestions. */
const STATEMENT_LABEL_BATCH = 100;
/** Page rebuilds after automatic rules move the ledger mid-page. */
const MAX_LABEL_ROUNDS = 3;

const identityLabel = {
  same_charge: "same",
  different_charge: "different",
  insufficient_evidence: "insufficient",
} as const;

type ChargeProposal = Awaited<ReturnType<typeof buildChargeProposals>>[number];
type DecisionUsage = Parameters<typeof labelStatementKind>[1]["usage"];

/**
 * A page's proposals in one build: per-charge builds repeat the same
 * account-wide reads, about 20 times the queries for a 20-charge page. A
 * build that throws falls back to one charge at a time, so only the bad
 * charge fails.
 */
async function buildPage(
  db: Database,
  charges: readonly ChargeRef[],
  onFailure: (charge: ChargeRef, error: unknown) => void,
) {
  const byCharge = new Map<string, ChargeProposal>();
  try {
    for (const proposal of await buildChargeProposals(db, charges))
      byCharge.set(chargeId(proposal.charge), proposal);
  } catch {
    // SILENT: the per-charge builds below record each failing charge's own error.
    await forEachConcurrently(
      charges,
      STATEMENT_PUBLISH_CONCURRENCY,
      async (charge) => {
        try {
          const [proposal] = await buildChargeProposals(db, [charge]);
          if (proposal) byCharge.set(chargeId(charge), proposal);
        } catch (error) {
          onFailure(charge, error);
        }
      },
    );
  }
  return byCharge;
}

/** The proposal's judgment with every decision-model label, asked at once. */
async function labelledJudgment(
  current: ChargeProposal,
  input: { port?: DecisionPort; usage: DecisionUsage },
) {
  const model = selectDecisionModel({ key: current.charge.chargeKey });
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
  const create = judgment.create;
  await settleDecisions([
    ...judgment.candidates.map(async (candidate) => {
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
      if (!decisionChoiceFitsContext(prompt)) return;
      const result = await runDecisionChoice({
        ...prompt,
        feature: STATEMENT_CHARGE_IDENTITY_FEATURE,
        decisionModel: model,
        port: input.port,
        usage: input.usage,
      });
      const choice =
        STATEMENT_CHARGE_IDENTITY_FEATURE.choices[result.selectedIndex ?? -1];
      candidate.label = {
        same: choice ? identityLabel[choice] : "insufficient",
        confidence: result.confidence,
        model,
      };
    }),
    ...(create
      ? [
          labelStatementKind(create, {
            subject: JSON.stringify(statement),
            transfer: judgment.transfer,
            model,
            port: input.port,
            usage: input.usage,
          }).then((labelled) => {
            judgment.create = labelled;
          }),
        ]
      : []),
  ]);
  judgment.clean = isClean(judgment, current.canonical.amount);
  return { judgment: statementTransactionJudgment.parse(judgment), model };
}

/**
 * Label pending rule suggestions with the decision model: whether each attach
 * candidate is the same charge, and every create's kind and counterparty.
 * Labels are advisory; they only decide whether a suggestion is
 * bulk-acceptable. Respects the automatic-work switch that gates AI refresh.
 *
 * A page builds once, labels and publishes charges concurrently, then applies
 * automatic rules one charge at a time. A rule that applied can take a
 * transaction another charge on the page proposed, so the page's remaining
 * charges are rebuilt and any whose evidence moved are labelled again.
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
  const usage = { db, runId, operation: "statement-suggestion-label" };
  const producer = (model: SupportedDecisionModel) => ({
    kind: "model" as const,
    model,
    revision: STATEMENT_CHARGE_IDENTITY_FEATURE.promptVersion,
    runId,
    evaluationId: null,
  });
  const failed: RunStepError[] = [];
  const failedCharges = new Set<string>();
  const fail = (charge: ChargeRef | null, error: unknown) => {
    if (charge) failedCharges.add(chargeId(charge));
    failed.push({
      at: new Date().toISOString(),
      message: runFailureText(error instanceof Error ? error : String(error)),
      ...(charge && { ref: `charge:${charge.source}:${charge.chargeKey}` }),
    });
  };
  const page = rows.slice(0, limit);
  let targets = page.flatMap((row) => {
    const subject = assessmentSubjects.statement_transaction.safeParse(
      row.subject,
    );
    if (!subject.success) {
      fail(null, subject.error);
      return [];
    }
    const { source, chargeKey } = subject.data;
    return [
      { charge: { source, chargeKey }, expected: row.evidenceFingerprint },
    ];
  });
  let stale = 0;
  const skipped = new Set<string>();
  const labelled = new Set<string>();
  const pauses: AiBudgetExhaustedError[] = [];
  for (let round = 0; round < MAX_LABEL_ROUNDS && targets.length; round++) {
    const proposals = await buildPage(
      db,
      targets.map((target) => target.charge),
      fail,
    );
    const ready = targets.flatMap((target) => {
      const key = chargeId(target.charge);
      const current = proposals.get(key);
      if (failedCharges.has(key)) return [];
      const moved = !current || current.evidenceFingerprint !== target.expected;
      // Stale evidence waits for the next generation pass to republish it.
      if (round === 0 && moved) {
        stale++;
        skipped.add(key);
        return [];
      }
      // After a rule, only a charge whose evidence moved is labelled again.
      return current && (round === 0 || moved) ? [{ target, current }] : [];
    });
    const published = new Map<string, string>();
    await forEachConcurrently(
      ready,
      STATEMENT_PUBLISH_CONCURRENCY,
      async ({ current }) => {
        if (pauses.length) return;
        try {
          const { judgment, model } = await labelledJudgment(current, {
            port: input.port,
            usage,
          });
          const outcome = await publishChargeProposal(
            db,
            await labelledProposal(current, judgment),
            producer(model),
          );
          if (outcome !== "published") return;
          labelled.add(chargeId(current.charge));
          published.set(chargeId(current.charge), current.evidenceFingerprint);
        } catch (error) {
          // The budget pauses the whole pass; any other failure is this charge's.
          if (error instanceof AiBudgetExhaustedError) pauses.push(error);
          else fail(current.charge, error);
        }
      },
    );
    // Rules run even when a pause ends the page: a published charge has left
    // the label queue, so a skipped rule would never be applied.
    const applied = new Set<string>();
    for (const { current } of ready) {
      const key = chargeId(current.charge);
      if (!published.has(key)) continue;
      try {
        const outcome = await applyAutomaticRulesForCharge(db, current.charge);
        if (outcome.applied.length) applied.add(key);
      } catch (error) {
        fail(current.charge, error);
      }
    }
    targets = targets.flatMap((target) => {
      const key = chargeId(target.charge);
      if (applied.has(key) || skipped.has(key) || failedCharges.has(key))
        return [];
      return [{ ...target, expected: published.get(key) ?? target.expected }];
    });
    if (pauses[0]) {
      // Without labels, a rule's moved evidence still republishes as rule
      // output, so the resumed pass labels it instead of skipping it as stale.
      if (applied.size)
        await regenerateCharges(
          db,
          targets.map((target) => target.charge),
        );
      throw pauses[0];
    }
    if (!applied.size) break;
  }
  const last = page.at(-1);
  return {
    labelled: labelled.size,
    stale,
    failed,
    next:
      rows.length > limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
    active: true,
  };
}

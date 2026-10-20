import { assessmentSubjects } from "@cubby/schemas/assessment";
import type { RunId } from "@cubby/schemas/identifiers";
import type { RunStepError } from "@cubby/schemas/run-step";
import {
  statementTransactionJudgment,
  type StatementTransactionJudgment,
  type StatementLabelCheckpoint,
  STATEMENT_LABEL_REVISION,
} from "@cubby/schemas/statement-suggestion";
import {
  selectDecisionModel,
  type SupportedDecisionModel,
} from "@cubby/shared/ai/models";
import { createLogger } from "@cubby/worker-tracing";

import { forEachConcurrently } from "~/lib/concurrency-limiter";
import { AiBudgetExhaustedError } from "~/server/ai/budget";
import {
  aiWorkDeferral,
  withCooperativeAiWork,
} from "~/server/ai/cooperative-work";
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
  statementLabelSubject,
  statementCandidateSubject,
} from "~/server/domains/statement-import/repo/statement-label-input";
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
  recordStatementLabelCheckpoint,
} from "~/server/domains/statement-import/repo/statement-suggestions";
import { decideStatementKind } from "~/server/domains/statement-import/repo/statement-transaction-kind";
import { labelStatementKind } from "~/server/domains/statement-import/service/statement-kind-labels";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";
import { applyAutomaticRulesForCharge } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

/** One label page labels at most this many suggestions. */
const STATEMENT_LABEL_BATCH = 10;
const STATEMENT_LABEL_DECISIONS = 32;
/** Page rebuilds after automatic rules move the ledger mid-page. */
const MAX_LABEL_ROUNDS = 3;
const log = createLogger("statement-suggestion-labels");

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

/** Partial model answers are checkpointed independently of advisory publication. */
async function labelledJudgment(
  current: ChargeProposal,
  input: {
    port?: DecisionPort;
    usage: DecisionUsage;
    checkpoint: StatementLabelCheckpoint | null;
    reserve(): boolean;
  },
) {
  const previous =
    input.checkpoint?.revision === STATEMENT_LABEL_REVISION &&
    canonicalJson(statementLabelSubject(input.checkpoint.judgment)) ===
      canonicalJson(statementLabelSubject(current.judgment))
      ? input.checkpoint
      : null;
  const model =
    previous?.model ?? selectDecisionModel({ key: current.charge.chargeKey });
  const judgment: StatementTransactionJudgment = structuredClone(
    current.judgment,
  );
  if (previous) {
    for (const candidate of judgment.candidates)
      candidate.label =
        previous.judgment.candidates.find(
          (saved) =>
            saved.transactionId === candidate.transactionId &&
            canonicalJson(statementCandidateSubject(saved)) ===
              canonicalJson(statementCandidateSubject(candidate)),
        )?.label ?? null;
    if (judgment.create && previous.judgment.create)
      Object.assign(
        judgment.create,
        decideStatementKind({
          amount: judgment.create.amount,
          votes: {
            ...judgment.create.votes,
            label: previous.judgment.create.votes.label,
          },
          counterparty: {
            ...judgment.create.counterparty,
            label: previous.judgment.create.counterparty.label,
          },
          transfer: judgment.transfer,
        }),
      );
  }
  const checkpoint: StatementLabelCheckpoint = {
    revision: STATEMENT_LABEL_REVISION,
    model,
    judgment,
    kind: previous?.kind ?? false,
    counterparty: previous?.counterparty ?? false,
  };
  const errors: unknown[] = [];
  let waitingUntil: number | null = null;
  const retainError = (error: unknown) => {
    const deferred = aiWorkDeferral(error);
    if (deferred)
      waitingUntil = Math.min(waitingUntil ?? Infinity, deferred.until);
    else errors.push(error);
  };
  const statement = statementLabelSubject(judgment);
  await forEachConcurrently(judgment.candidates, 4, async (candidate) => {
    if (candidate.label !== null || waitingUntil !== null) return;
    const prompt = STATEMENT_CHARGE_IDENTITY_FEATURE.prompt(
      JSON.stringify({
        statement,
        transaction: statementCandidateSubject(candidate),
      }),
    );
    if (!decisionChoiceFitsContext(prompt)) {
      candidate.label = {
        same: "insufficient",
        confidence: "low",
        model: null,
      };
      return;
    }
    if (!input.reserve()) return;
    try {
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
    } catch (error) {
      retainError(error);
    }
  });
  for (const part of ["kind", "counterparty"] as const) {
    if (
      !judgment.create ||
      checkpoint[part] ||
      waitingUntil !== null ||
      !input.reserve()
    )
      continue;
    try {
      judgment.create = await labelStatementKind(judgment.create, {
        subject: JSON.stringify(statement),
        transfer: judgment.transfer,
        model,
        port: input.port,
        usage: input.usage,
        parts: [part],
      });
      checkpoint[part] = true;
    } catch (error) {
      retainError(error);
    }
  }
  judgment.clean = isClean(judgment, current.canonical.amount);
  checkpoint.judgment = statementTransactionJudgment.parse(judgment);
  return {
    checkpoint,
    model,
    errors,
    waitingUntil,
    complete:
      judgment.candidates.every((candidate) => candidate.label !== null) &&
      (!judgment.create || (checkpoint.kind && checkpoint.counterparty)),
  };
}

/**
 * Label pending rule suggestions with the decision model: whether each attach
 * candidate is the same charge, and every create's kind and counterparty.
 * Labels are advisory; they only decide whether a suggestion is
 * bulk-acceptable. Respects the automatic-work switch that gates AI refresh.
 *
 * A page builds once, bounds concurrent decisions within each charge, then applies
 * automatic rules one charge at a time. A rule that applied can take a
 * transaction another charge on the page proposed, so the page's remaining
 * charges are rebuilt and any whose evidence moved are labelled again.
 */
export async function labelStatementSuggestions(
  db: Database,
  input: {
    limit?: number;
    decisionLimit?: number;
    cooperative?: boolean;
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
  waitingUntil: number | null;
  paused: { reason: string; until: string } | null;
}> {
  const empty = {
    labelled: 0,
    stale: 0,
    failed: [],
    next: null,
    waitingUntil: null,
    paused: null,
  };
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
  let decisionsLeft = input.decisionLimit ?? STATEMENT_LABEL_DECISIONS;
  const reserve = () => {
    if (decisionsLeft <= 0) return false;
    decisionsLeft--;
    return true;
  };
  let unfinished: LabelCursor | null = null;
  let waitingUntil: number | null = null;
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
      { charge: { source, chargeKey }, expected: row.evidenceFingerprint, row },
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
    log.info("Statement label round", {
      round: round + 1,
      charges: ready.length,
      // Logical decisions, before context-fit checks and provider retries;
      // this is workload evidence, not a measurement of Worker subrequests.
      plannedDecisions: ready.reduce(
        (total, { current }) =>
          total +
          current.judgment.candidates.length +
          (current.judgment.create ? 2 : 0),
        0,
      ),
    });
    for (const { current, target } of ready) {
      if (pauses.length) break;
      try {
        const compute = () =>
          labelledJudgment(current, {
            port: input.port,
            usage,
            checkpoint: target.row.checkpoint,
            reserve,
          });
        const result = await (input.cooperative
          ? withCooperativeAiWork(compute)
          : compute());
        target.row.checkpoint = result.checkpoint;
        const saved = await recordStatementLabelCheckpoint(db, {
          charge: current.charge,
          evidenceFingerprint: target.expected,
          checkpoint: result.checkpoint,
        });
        if (!saved)
          throw new Error(
            "Statement label checkpoint lost its active evidence fence",
          );
        if (!result.complete || result.errors.length) {
          if (result.errors.length) {
            const pause = result.errors.find(
              (error) => error instanceof AiBudgetExhaustedError,
            );
            if (pause instanceof AiBudgetExhaustedError) {
              pauses.push(pause);
              unfinished = {
                createdAt: target.row.createdAt,
                id: target.row.id,
                inclusive: true,
              };
            } else
              fail(
                current.charge,
                new Error(
                  result.errors
                    .map((error) =>
                      runFailureText(
                        error instanceof Error ? error : String(error),
                      ),
                    )
                    .join("\n"),
                ),
              );
            continue;
          }
          unfinished = {
            createdAt: target.row.createdAt,
            id: target.row.id,
            inclusive: true,
          };
          waitingUntil = result.waitingUntil;
          break;
        }
        const outcome = await publishChargeProposal(
          db,
          await labelledProposal(current, result.checkpoint.judgment),
          producer(result.model),
        );
        if (outcome !== "published") continue;
        labelled.add(chargeId(current.charge));
        published.set(chargeId(current.charge), current.evidenceFingerprint);
      } catch (error) {
        // The budget pauses the whole pass; any other failure is this charge's.
        if (error instanceof AiBudgetExhaustedError) {
          pauses.push(error);
          unfinished = {
            createdAt: target.row.createdAt,
            id: target.row.id,
            inclusive: true,
          };
        } else fail(current.charge, error);
      }
    }
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
    if (pauses[0] || unfinished) {
      // Without labels, a rule's moved evidence still republishes as rule
      // output, so the resumed pass labels it instead of skipping it as stale.
      if (applied.size)
        await regenerateCharges(
          db,
          targets.map((target) => target.charge),
        );
      if (pauses[0] && !input.cooperative) throw pauses[0];
      break;
    }
    if (!applied.size) break;
  }
  const last = page.at(-1);
  return {
    labelled: labelled.size,
    stale,
    failed,
    next:
      unfinished ??
      (rows.length > limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null),
    active: true,
    waitingUntil,
    paused: pauses[0]
      ? { reason: pauses[0].message, until: pauses[0].resumeAt }
      : null,
  };
}

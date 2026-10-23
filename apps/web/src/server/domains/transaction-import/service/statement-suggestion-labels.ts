import { assessmentSubjects } from "@cubby/schemas/assessment";
import { financialTransactionKind } from "@cubby/schemas/financial-transaction";
import type { RunId } from "@cubby/schemas/identifiers";
import type { RunStepError } from "@cubby/schemas/run-step";
import {
  statementTransactionJudgment,
  statementCounterparty,
  type StatementTransactionJudgment,
  type StatementLabelCheckpoint,
  STATEMENT_LABEL_REVISION,
} from "@cubby/schemas/statement-suggestion";
import { JOB_PAGE_LIMITS } from "@cubby/shared/job-page-limits";
import { createLogger } from "@cubby/worker-tracing";

import { forEachConcurrently } from "~/lib/concurrency-limiter";
import { AiBudgetExhaustedError } from "~/server/ai/budget";
import {
  aiWorkDeferral,
  withCooperativeAiWork,
} from "~/server/ai/cooperative-work";
import {
  decisionChoiceFitsContext,
  decisionModelFor,
  type DecisionPort,
  settleDecisionChoices,
  type DecisionChoiceResult,
  type DecisionChoiceArgs,
} from "~/server/ai/decision-model";
import { withAiInputs } from "~/server/ai/evaluation-inputs";
import { withFieldSuggestionBatch } from "~/server/ai/field-suggest/suggest-fields";
import {
  STATEMENT_CHARGE_IDENTITY_FEATURE,
  STATEMENT_COUNTERPARTY_FEATURE,
  STATEMENT_TRANSACTION_KIND_FEATURE,
} from "~/server/ai/policy/features";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import type { FinancialSpendingPage } from "~/server/domains/financial-transaction/repo/financial-spending";
import {
  adviseSpending,
  needsSpendingAdvice,
  type SpendingAdvicePort,
} from "~/server/domains/financial-transaction/service/spending-advice";
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import {
  statementLabelSubject,
  statementCandidateSubject,
} from "~/server/domains/transaction-import/repo/statement-label-input";
import {
  prepareStatementSpending,
  prepareStatementSpendingFacts,
} from "~/server/domains/transaction-import/repo/statement-spending";
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
  completeStatementApplications,
} from "~/server/domains/transaction-import/repo/statement-suggestions";
import { decideStatementKind } from "~/server/domains/transaction-import/repo/statement-transaction-kind";
import { applyAutomaticRulesForCharge } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import { canonicalJson } from "~/server/lib/canonical-json";
import { isWorkflowInterrupted } from "~/server/workflows/runs/execution";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

const STATEMENT_LABEL_BATCH = JOB_PAGE_LIMITS.suggestionsPerPage;
/** Page rebuilds after automatic rules move the ledger mid-page. */
const MAX_LABEL_ROUNDS = 3;
const log = createLogger("statement-suggestion-labels");

const identityLabel = {
  same_charge: "same",
  different_charge: "different",
  insufficient_evidence: "insufficient",
} as const;

type ChargeProposal = Awaited<ReturnType<typeof buildChargeProposals>>[number];
type LabelPreparation = Pick<
  ChargeProposal,
  "charge" | "judgment" | "evidenceFingerprint"
> & { amount: number };

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
  } catch (error) {
    if (isWorkflowInterrupted(error)) throw error;
    // SILENT: the per-charge builds below record each failing charge's own error.
    await forEachConcurrently(
      charges,
      STATEMENT_PUBLISH_CONCURRENCY,
      async (charge) => {
        try {
          const [proposal] = await buildChargeProposals(db, [charge]);
          if (proposal) byCharge.set(chargeId(charge), proposal);
        } catch (error) {
          if (isWorkflowInterrupted(error)) throw error;
          onFailure(charge, error);
        }
      },
    );
  }
  return byCharge;
}

/** Partial model answers are checkpointed independently of advisory publication. */
function prepareLabelledJudgment(
  db: Database,
  current: LabelPreparation,
  input: {
    port?: DecisionPort;
    spendingAdvice?: SpendingAdvicePort;
    usage: DecisionChoiceArgs["usage"];
    checkpoint: StatementLabelCheckpoint | null;
    reserve(
      questions: readonly DecisionChoiceArgs[],
      additional?: number,
    ): () => boolean;
  },
) {
  const previous =
    input.checkpoint?.revision === STATEMENT_LABEL_REVISION &&
    canonicalJson(statementLabelSubject(input.checkpoint.judgment)) ===
      canonicalJson(statementLabelSubject(current.judgment))
      ? input.checkpoint
      : null;
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
    model: previous?.model ?? null,
    models: previous?.models ?? [],
    judgment,
    kind: previous?.kind ?? false,
    counterparty: previous?.counterparty ?? false,
    spending: previous?.spending ?? false,
  };
  const recordModel = (model: string) => {
    checkpoint.models = [...new Set([...checkpoint.models, model])];
    checkpoint.model =
      checkpoint.models.length === 1 ? checkpoint.models[0]! : null;
  };
  const countLabels = () =>
    judgment.candidates.filter((entry) => entry.label !== null).length +
    Number(checkpoint.kind) +
    Number(checkpoint.counterparty) +
    Number(checkpoint.spending);

  const reused = countLabels();
  const errors: unknown[] = [];
  let waitingUntil: number | null = null;
  const retainError = (error: unknown) => {
    if (isWorkflowInterrupted(error)) throw error;
    const deferred = aiWorkDeferral(error);
    if (deferred)
      waitingUntil = Math.min(waitingUntil ?? Infinity, deferred.until);
    else errors.push(error);
  };
  const decisions: {
    args: DecisionChoiceArgs;
    apply(result: DecisionChoiceResult): void;
  }[] = [];
  const statement = statementLabelSubject(judgment);
  for (const candidate of judgment.candidates) {
    if (candidate.label !== null) continue;
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
      continue;
    }
    const args: DecisionChoiceArgs = {
      ...prompt,
      feature: STATEMENT_CHARGE_IDENTITY_FEATURE,
      port: input.port,
      usage: input.usage,
    };
    const model = decisionModelFor(args);
    decisions.push({
      args,
      apply(result) {
        recordModel(model);
        const choice =
          STATEMENT_CHARGE_IDENTITY_FEATURE.choices[result.selectedIndex ?? -1];
        candidate.label = {
          same: choice ? identityLabel[choice] : "insufficient",
          confidence: result.confidence,
          model,
        };
      },
    });
  }
  // Both votes use the original statement evidence, independently of identity
  // answers and of each other. Enqueue them with the whole page's questions.
  for (const part of ["kind", "counterparty"] as const) {
    if (!judgment.create || checkpoint[part]) continue;
    const feature =
      part === "kind"
        ? STATEMENT_TRANSACTION_KIND_FEATURE
        : STATEMENT_COUNTERPARTY_FEATURE;
    const prompt = feature.prompt(JSON.stringify(statement));
    const apply = (choice: string | null) => {
      if (!judgment.create) return;
      if (part === "kind")
        judgment.create.votes.label = financialTransactionKind
          .nullable()
          .catch(null)
          .parse(choice);
      else
        judgment.create.counterparty.label = statementCounterparty.shape.label
          .catch(null)
          .parse(choice);
      checkpoint[part] = true;
    };
    if (!decisionChoiceFitsContext(prompt)) {
      apply(null);
      continue;
    }
    const args: DecisionChoiceArgs = {
      ...prompt,
      feature,
      port: input.port,
      usage: input.usage,
    };
    decisions.push({
      args,
      apply(result) {
        recordModel(decisionModelFor(args));
        const choice = feature.choices[result.selectedIndex ?? -1];
        apply(choice && result.confidence === "high" ? choice : null);
      },
    });
  }
  // Only context-fitting questions spend the page allowance. Reserve a whole
  // charge synchronously, so a small allowance completes earlier charges first.
  const spendingReserved =
    !checkpoint.spending && needsSpendingAdvice(judgment);
  const reserved = input.reserve(
    decisions.map((decision) => decision.args),
    Number(spendingReserved),
  );
  return {
    decisions: decisions.filter(() => reserved()),
    retainError,
    judgment,
    classify() {
      if (judgment.create)
        Object.assign(
          judgment.create,
          decideStatementKind({
            amount: judgment.create.amount,
            votes: judgment.create.votes,
            counterparty: judgment.create.counterparty,
            transfer: judgment.transfer,
          }),
        );
    },
    async finish(page?: FinancialSpendingPage) {
      if (checkpoint.spending && previous)
        judgment.spending = await prepareStatementSpending(
          db,
          judgment,
          previous.judgment.spending?.request.advice ?? null,
          page,
        );
      if (!checkpoint.spending && !needsSpendingAdvice(judgment)) {
        judgment.spending = await prepareStatementSpending(
          db,
          judgment,
          null,
          page,
        );
        checkpoint.spending = true;
      }
      if (
        !checkpoint.spending &&
        !errors.length &&
        waitingUntil === null &&
        (spendingReserved ? reserved() : input.reserve([], 1)())
      ) {
        try {
          const spending = await withAiInputs(false, () =>
            adviseSpending(db, {
              judgment,
              runId: input.usage!.runId,
              port: input.port,
              spendingAdvice: input.spendingAdvice,
              preparation: page,
            }),
          );
          for (const call of spending.inputs) recordModel(call.model);
          const advice = spending.result;
          judgment.spending = await prepareStatementSpending(
            db,
            judgment,
            advice,
            page,
          );
          checkpoint.spending = true;
        } catch (error) {
          retainError(error);
        }
      }
      judgment.clean = isClean(judgment, current.amount);
      checkpoint.judgment = statementTransactionJudgment.parse(judgment);
      return {
        checkpoint,
        labels: { reused, generated: Math.max(0, countLabels() - reused) },
        model: checkpoint.model,
        errors,
        waitingUntil,
        complete:
          judgment.candidates.every((candidate) => candidate.label !== null) &&
          (!judgment.create || (checkpoint.kind && checkpoint.counterparty)) &&
          checkpoint.spending,
      };
    },
  };
}

/** A complete publication owns durability; a failed one retains only newly computed answers. */
async function publishStatementLabels(
  db: Database,
  input: {
    proposal: ChargeProposal;
    checkpoint: Parameters<typeof recordStatementLabelCheckpoint>[1];
    producer: Parameters<typeof publishChargeProposal>[2];
    retainProgress: () => Promise<boolean>;
  },
) {
  try {
    return await publishChargeProposal(
      db,
      await labelledProposal(
        input.proposal,
        input.checkpoint.checkpoint.judgment,
      ),
      input.producer,
      input.checkpoint,
    );
  } catch (publicationError) {
    if (isWorkflowInterrupted(publicationError)) throw publicationError;
    try {
      if (!(await input.retainProgress())) return null;
    } catch (checkpointError) {
      if (isWorkflowInterrupted(checkpointError)) throw checkpointError;
      throw new AggregateError(
        [publicationError, checkpointError],
        [publicationError, checkpointError]
          .map((error) =>
            runFailureText(error instanceof Error ? error : String(error)),
          )
          .join("\n"),
        { cause: checkpointError },
      );
    }
    throw publicationError;
  }
}

function statementLabelCursors(
  page: ReadonlyArray<
    Pick<
      Awaited<ReturnType<typeof suggestionsNeedingLabels>>[number],
      "createdAt" | "cursorId"
    >
  >,
  unfinished: ReadonlySet<string>,
  hasMore: boolean,
) {
  const last = page.at(-1);
  const firstUnfinished = page.find((row) => unfinished.has(row.cursorId));
  return {
    through: last ? { createdAt: last.createdAt, id: last.cursorId } : null,
    next:
      (firstUnfinished
        ? {
            createdAt: firstUnfinished.createdAt,
            id: firstUnfinished.cursorId,
            inclusive: true,
          }
        : null) ??
      (hasMore && last
        ? { createdAt: last.createdAt, id: last.cursorId }
        : null),
  };
}

/**
 * Label pending rule suggestions with the decision model: whether each attach
 * candidate is the same charge, and every create's kind and counterparty.
 * Labels are advisory; they only decide whether a suggestion is
 * bulk-acceptable. Respects the automatic-work switch that gates AI refresh.
 *
 * A page builds once, fans model decisions out to egress admission, then applies
 * automatic rules one charge at a time. A rule that applied can take a
 * transaction another charge on the page proposed, so the page's remaining
 * charges are rebuilt and any whose evidence moved are labelled again.
 */
async function runStatementLabelBatch(
  db: Database,
  input: {
    limit?: number;
    decisionLimit?: number;
    cooperative?: boolean;
    port?: DecisionPort;
    spendingAdvice?: SpendingAdvicePort;
    /** The Run the model calls are accounted to (a Sweep's step). */
    runId?: RunId | null;
    after?: LabelCursor | null;
    /** Label only this import's charges (an import-scoped Sweep). */
    importId?: string | null;
  } = {},
): Promise<{
  labelled: number;
  /** Label/application stages settled, including recovered publication receipts. */
  completed: number;
  labels: { reused: number; generated: number };
  /** Suggestions whose evidence moved since publication; regeneration relabels them. */
  stale: number;
  skippedIds: string[];
  failed: RunStepError[];
  next: LabelCursor | null;
  through: LabelCursor | null;
  /** False when the automatic-work switch is off, so nothing was asked. */
  active: boolean;
  waitingUntil: number | null;
  paused: { reason: string; until: string } | null;
}> {
  const skippedIds: string[] = [];
  const empty = {
    labelled: 0,
    completed: 0,
    labels: { reused: 0, generated: 0 },
    stale: 0,
    skippedIds,
    failed: [],
    next: null,
    through: null,
    waitingUntil: null,
    paused: null,
  };
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled && !input.port) return { ...empty, active: false };
  const limit = Math.min(
    input.limit ?? STATEMENT_LABEL_BATCH,
    STATEMENT_LABEL_BATCH,
  );
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
  const producer = (model: string | null) => ({
    kind: "model" as const,
    model,
    revision: STATEMENT_CHARGE_IDENTITY_FEATURE.promptVersion,
    runId,
    evaluationId: null,
  });
  const failed: RunStepError[] = [];
  const failedCharges = new Set<string>();
  const fail = (charge: ChargeRef | null, error: unknown) => {
    if (isWorkflowInterrupted(error)) throw error;
    if (charge) failedCharges.add(chargeId(charge));
    failed.push({
      at: new Date().toISOString(),
      message: runFailureText(error instanceof Error ? error : String(error)),
      ...(charge && { ref: `charge:${charge.source}:${charge.chargeKey}` }),
    });
  };
  const page = rows.slice(0, limit);
  let decisionsLeft = Math.min(
    input.decisionLimit ?? JOB_PAGE_LIMITS.maxDecisionQuestionsPerPage,
    JOB_PAGE_LIMITS.maxDecisionQuestionsPerPage,
  );
  const reserve = (
    questions: readonly DecisionChoiceArgs[],
    additional = 0,
  ) => {
    const admitted = questions.map(() => {
      if (decisionsLeft <= 0) {
        return false;
      }
      decisionsLeft--;
      return true;
    });
    for (let index = 0; index < additional; index++) {
      const allowed = decisionsLeft > 0;
      if (allowed) decisionsLeft--;
      admitted.push(allowed);
    }
    let index = 0;
    return () => {
      return admitted[index++] ?? false;
    };
  };
  const unfinished = new Set<string>();
  const retainUnfinished = (row: (typeof page)[number]) => {
    unfinished.add(row.cursorId);
  };
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
  const completed = new Set<string>();
  const labels = { reused: 0, generated: 0 };
  const pauses: AiBudgetExhaustedError[] = [];
  type ReadyLabels = {
    target: (typeof targets)[number];
    moved: boolean;
    current: ChargeProposal & { amount: number };
  };
  for (let round = 0; round < MAX_LABEL_ROUNDS && targets.length; round++) {
    const proposals = await buildPage(
      db,
      targets
        .filter(
          (target) =>
            !target.row.applicationPending &&
            !failedCharges.has(chargeId(target.charge)),
        )
        .map((target) => target.charge),
      fail,
    );
    const ready = targets.flatMap<ReadyLabels>((target) => {
      if (target.row.applicationPending) return [];
      const key = chargeId(target.charge);
      if (failedCharges.has(key)) return [];
      const current = proposals?.get(key);
      const moved = !current || current.evidenceFingerprint !== target.expected;
      // Stale evidence waits for the next generation pass to republish it.
      if (round === 0 && moved) {
        stale++;
        skippedIds.push(target.row.id);
        skipped.add(key);
        return [];
      }
      // After a rule, only a charge whose evidence moved is labelled again.
      return current && (round === 0 || moved)
        ? [
            {
              target,
              current: { ...current, amount: current.canonical.amount },
              moved,
            },
          ]
        : [];
    });
    const published = new Map(
      targets
        .filter((target) => target.row.applicationPending)
        .map((target) => [chargeId(target.charge), target.expected]),
    );
    const receipts = new Map(
      targets
        .filter((target) => target.row.applicationPending)
        .map((target) => [chargeId(target.charge), target.row.id]),
    );
    log.info("Statement label round", {
      round: round + 1,
      charges: ready.length,
      // Logical decisions, before context-fit checks and provider retries;
      // this is workload evidence, not a measurement of Worker subrequests.
      plannedDecisions: ready.reduce(
        (total, { current }) =>
          total +
          current.judgment.candidates.length +
          (current.judgment.create ? 2 : 0) +
          1,
        0,
      ),
    });
    // Model work holds no publish transaction. All started decisions settle
    // before checkpoint/publication, whose separate DB fan-out stays at four.
    const prepared = ready.map(({ current, target }) => {
      try {
        return {
          status: "fulfilled" as const,
          value: prepareLabelledJudgment(db, current, {
            port: input.port,
            spendingAdvice: input.spendingAdvice,
            usage,
            checkpoint: target.row.checkpoint,
            reserve,
          }),
        };
      } catch (reason) {
        return { status: "rejected" as const, reason };
      }
    });
    const decisions = prepared.flatMap((result) =>
      result.status === "fulfilled"
        ? result.value.decisions.map((decision) => ({
            ...decision,
            reject: result.value.retainError,
          }))
        : [],
    );
    const answers = await settleDecisionChoices(
      decisions,
      (decision) => decision.args,
      { cooperative: input.cooperative },
    );
    for (const answer of answers) {
      if (answer.status === "fulfilled") answer.item.apply(answer.value);
      else answer.item.reject(answer.reason);
    }
    const classified = prepared.map((result) => {
      if (result.status !== "fulfilled") return result;
      try {
        result.value.classify();
        return result;
      } catch (reason) {
        return { status: "rejected" as const, reason };
      }
    });
    let spendingPage: FinancialSpendingPage | undefined;
    try {
      spendingPage = await prepareStatementSpendingFacts(
        db,
        classified.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.judgment] : [],
        ),
      );
    } catch (error) {
      if (isWorkflowInterrupted(error)) throw error;
      // Shared discovery is advisory; isolate failures through the existing per-charge path.
    }
    const finish = () =>
      withFieldSuggestionBatch(() =>
        Promise.all(
          classified.map(async (result) => {
            if (result.status !== "fulfilled") return result;
            try {
              return {
                status: "fulfilled" as const,
                value: await result.value.finish(spendingPage),
              };
            } catch (reason) {
              return { status: "rejected" as const, reason };
            }
          }),
        ),
      );
    const computed = await (input.cooperative
      ? withCooperativeAiWork(finish)
      : finish());
    await forEachConcurrently(
      ready.map((entry, index) => ({
        ...entry,
        computed: computed[index]!,
      })),
      STATEMENT_PUBLISH_CONCURRENCY,
      async (entry) => {
        const { current, target, computed } = entry;
        try {
          if (computed.status === "rejected") throw computed.reason;
          const result = computed.value;
          labels.reused += result.labels.reused;
          labels.generated += result.labels.generated;
          target.row.checkpoint = result.checkpoint;
          const checkpointInput = {
            charge: current.charge,
            evidenceFingerprint: target.expected,
            checkpoint: result.checkpoint,
          };
          const retainProgress = async () => {
            // A deferred/zero-budget charge has no new answers to persist.
            // Reused answers are already durable on the selected checkpoint.
            if (!result.labels.generated) return true;
            const saved = await recordStatementLabelCheckpoint(
              db,
              checkpointInput,
            );
            if (saved === "settled") {
              skipped.add(chargeId(current.charge));
              return false;
            }
            if (saved === "moved")
              throw new Error(
                "Statement label checkpoint lost its active evidence fence",
              );
            return true;
          };
          if (!result.complete || result.errors.length) {
            if (!(await retainProgress())) return;
          }
          if (!result.complete || result.errors.length) {
            if (result.errors.length) {
              const pause = result.errors.find(
                (error) => error instanceof AiBudgetExhaustedError,
              );
              if (pause instanceof AiBudgetExhaustedError) {
                pauses.push(pause);
                retainUnfinished(target.row);
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
              return;
            }
            retainUnfinished(target.row);
            if (result.waitingUntil !== null)
              waitingUntil = Math.min(
                waitingUntil ?? Infinity,
                result.waitingUntil,
              );
            return;
          }
          const outcome = await publishStatementLabels(db, {
            proposal: entry.current,
            checkpoint: checkpointInput,
            producer: producer(result.model),
            retainProgress,
          });
          if (!outcome) return;
          if (outcome.outcome !== "published") {
            skipped.add(chargeId(current.charge));
            unfinished.delete(target.row.cursorId);
            return;
          }
          labelled.add(chargeId(current.charge));
          published.set(chargeId(current.charge), current.evidenceFingerprint);
          receipts.set(chargeId(current.charge), outcome.assessmentId);
          target.row.id = outcome.assessmentId;
          target.row.applicationPending = true;
        } catch (error) {
          if (isWorkflowInterrupted(error)) throw error;
          // The budget pauses the whole pass; any other failure is this charge's.
          if (error instanceof AiBudgetExhaustedError) {
            pauses.push(error);
            retainUnfinished(target.row);
          } else fail(current.charge, error);
        }
      },
    );
    // Model work may finish out of order; effects admit only the original
    // ready prefix. Later publications keep their receipts for durable resume.
    const applied = new Set<string>();
    const settledReceipts: string[] = [];
    const settledCharges: string[] = [];
    const rebuild = new Set<string>();
    const reconsidered = new Set(
      ready.map(({ current }) => chargeId(current.charge)),
    );
    // A prior-round completion is resolved unless changed evidence required publication again.
    const awaitsPublication = (key: string) =>
      !completed.has(key) || reconsidered.has(key);
    let applicationBlocked = false;
    for (const target of targets) {
      const key = chargeId(target.charge);
      if (skipped.has(key)) {
        unfinished.delete(target.row.cursorId);
        continue;
      }
      if (failedCharges.has(key)) {
        // Root retries the original input while attempts remain. After
        // exhaustion next must advance past this failure, not reset its budget.
        unfinished.delete(target.row.cursorId);
        applicationBlocked = true;
        continue;
      }
      if (!published.has(key)) {
        if (awaitsPublication(key)) applicationBlocked = true;
        continue;
      }
      if (applicationBlocked) {
        retainUnfinished(target.row);
        continue;
      }
      try {
        if (input.importId) await regenerateCharges(db, [target.charge]);
        const outcome = await applyAutomaticRulesForCharge(
          db,
          target.charge,
          Boolean(input.importId),
        );
        if (outcome.refused.length) {
          const [fresh] = await buildChargeProposals(db, [target.charge]);
          if (fresh && fresh.evidenceFingerprint !== published.get(key)) {
            // An earlier application can consume this charge's candidate.
            // Rebuild through the existing ordered rounds instead of retrying
            // an obsolete application receipt forever.
            target.row.applicationPending = false;
            rebuild.add(key);
            applicationBlocked = true;
            continue;
          }
          throw new Error(
            `Automatic statement application refused: ${JSON.stringify(outcome.refused)}`,
          );
        }
        // Newly published rows replaced the selected row; clear the active
        // receipt only after this charge's ordered application has settled.
        settledReceipts.push(receipts.get(key)!);
        settledCharges.push(key);
        target.row.applicationPending = false;
        unfinished.delete(target.row.cursorId);
        if (outcome.applied.length) applied.add(key);
      } catch (error) {
        fail(target.charge, error);
        unfinished.delete(target.row.cursorId);
        applicationBlocked = true;
      }
    }
    await completeStatementApplications(db, settledReceipts);
    for (const key of settledCharges) completed.add(key);
    if (rebuild.size && round === MAX_LABEL_ROUNDS - 1) {
      const remaining = targets.filter((target) =>
        rebuild.has(chargeId(target.charge)),
      );
      await regenerateCharges(
        db,
        remaining.map((target) => target.charge),
      );
      for (const target of remaining) retainUnfinished(target.row);
    }
    targets = targets.flatMap((target) => {
      const key = chargeId(target.charge);
      if (applied.has(key) || skipped.has(key)) return [];
      return [{ ...target, expected: published.get(key) ?? target.expected }];
    });
    if (pauses[0] || (unfinished.size && !rebuild.size)) {
      // Without labels, a rule's moved evidence still republishes as rule
      // output, so the resumed pass labels it instead of skipping it as stale.
      if (
        applied.size ||
        ready.some(
          ({ current, moved }) =>
            moved && !published.has(chargeId(current.charge)),
        )
      )
        await regenerateCharges(
          db,
          targets.map((target) => target.charge),
        );
      if (pauses[0] && !input.cooperative) throw pauses[0];
      break;
    }
    if (!applied.size && !rebuild.size) break;
  }
  return {
    labelled: labelled.size,
    completed: completed.size,
    labels,
    stale,
    skippedIds,
    failed,
    ...statementLabelCursors(page, unfinished, rows.length > limit),
    active: true,
    waitingUntil,
    paused: pauses[0]
      ? { reason: pauses[0].message, until: pauses[0].resumeAt }
      : null,
  };
}

export function labelStatementSuggestions(
  db: Database,
  input: Parameters<typeof runStatementLabelBatch>[1] = {},
) {
  return runStatementLabelBatch(db, input);
}

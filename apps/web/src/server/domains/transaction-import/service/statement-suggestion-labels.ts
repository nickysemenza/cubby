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
  AiWorkDeferredError,
  aiWorkDeferral,
  withCooperativeAiWork,
} from "~/server/ai/cooperative-work";
import {
  decisionChoiceFitsContext,
  decisionModelFor,
  type DecisionPort,
  settleDecisionChoices,
  settleDecisionWorkItems,
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
  publishCompleteStatementLabels,
  type CompleteStatementLabelPublication,
  type StatementLabelPublicationResult,
  regenerateCharges,
  STATEMENT_PUBLISH_CONCURRENCY,
  suggestionsNeedingLabels,
  statementLabelTargetsInScope,
  type StatementSuggestionScope,
  type LabelCursor,
  recordStatementLabelCheckpoint,
  completeStatementApplications,
  completeNoActionStatementPrefix,
  STATEMENT_APPLICATION_PREFIX_LIMIT,
  repairStatementApplicationReceipts,
} from "~/server/domains/transaction-import/repo/statement-suggestions";
import { decideStatementKind } from "~/server/domains/transaction-import/repo/statement-transaction-kind";
import { applyAutomaticRulesForCharge } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import {
  importOnlyStatementRuleStamps,
  matchStatementRules,
} from "~/server/generic/assessment/repo/automatic-rules";
import { withJobPhase } from "~/server/generic/jobs/context";
import type { PageWork } from "~/server/generic/jobs/page-work";
import { canonicalJson } from "~/server/lib/canonical-json";
import { isWorkflowInterrupted } from "~/server/workflows/runs/execution";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

// A label page includes merchant discovery in addition to batched decisions.
// Keep its retry/checkpoint unit small enough to settle within a live Job claim.
const STATEMENT_LABEL_BATCH = 32;
// Admit one default page together so a slow merchant does not serialize four waves.
// Larger explicit pages still retain a bounded wave and the cooperative deadline.
const STATEMENT_SPENDING_CONCURRENCY = 32;
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
    admission: {
      available(): boolean;
      reserve(): boolean;
    };
  },
) {
  const previous =
    input.checkpoint?.revision === STATEMENT_LABEL_REVISION &&
    canonicalJson(statementLabelSubject(input.checkpoint.judgment)) ===
      canonicalJson(statementLabelSubject(current.judgment))
      ? input.checkpoint
      : null;
  // Keep an untouched suffix for the next page without cloning its judgments
  // or rendering fresh prompts. Compatible checkpoints can still finish here.
  if (!previous && !input.admission.available()) return null;
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
    if (!input.admission.available()) break;
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
    if (!input.admission.reserve()) continue;
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
    if (!input.admission.available()) break;
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
    if (!input.admission.reserve()) continue;
    decisions.push({
      args,
      apply(result) {
        recordModel(decisionModelFor(args));
        const choice = feature.choices[result.selectedIndex ?? -1];
        apply(choice && result.confidence === "high" ? choice : null);
      },
    });
  }
  // Reserve spending before preparing the next charge, preserving the original
  // identity/kind/counterparty/spending order. Context defaults reserve nothing.
  const spendingReserved =
    !checkpoint.spending && needsSpendingAdvice(judgment);
  const spendingAdmitted = spendingReserved && input.admission.reserve();
  return {
    decisions,
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
    async finish(
      page?: FinancialSpendingPage,
      usageFor?: Parameters<typeof adviseSpending>[1]["usageFor"],
    ) {
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
        (spendingReserved ? spendingAdmitted : input.admission.reserve())
      ) {
        try {
          const spending = await withAiInputs(false, () =>
            adviseSpending(db, {
              judgment,
              runId: input.usage!.runId,
              port: input.port,
              spendingAdvice: input.spendingAdvice,
              preparation: page,
              usageFor,
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

/** A genuine publication failure retains newly computed answers without hiding either failure. */
async function retainFailedStatementPublication(
  publicationError: unknown,
  retainProgress: () => Promise<boolean>,
) {
  if (isWorkflowInterrupted(publicationError)) throw publicationError;
  try {
    if (!(await retainProgress())) return;
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

async function completeStatementPublicationResult(
  result: StatementLabelPublicationResult | undefined,
  retainProgress: () => Promise<boolean>,
) {
  if (!result || result.kind === "failed") {
    await retainFailedStatementPublication(
      result?.error ??
        new Error("Complete statement publication returned no outcome"),
      retainProgress,
    );
    return null;
  }
  return result.kind === "ready" ? result : null;
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

async function completeNoActionTargets(
  db: Database,
  input: {
    targets: readonly {
      charge: ChargeRef;
      row: Awaited<ReturnType<typeof suggestionsNeedingLabels>>[number];
    }[];
    receipts: ReadonlyMap<string, string>;
    published: ReadonlyMap<string, string>;
    skipped: ReadonlySet<string>;
    failedCharges: ReadonlySet<string>;
    completed: Set<string>;
    unfinished: Set<string>;
    scope?: StatementSuggestionScope;
  },
) {
  const window = [];
  const positions: number[] = [];
  for (const [index, next] of input.targets.entries()) {
    const key = chargeId(next.charge);
    // The ordered application loop already treats these charges as settled.
    // They need no receipt lock and must not split the remaining ready prefix.
    if (input.skipped.has(key)) continue;
    const assessmentId = input.receipts.get(key);
    const evidenceFingerprint = input.published.get(key);
    if (
      input.failedCharges.has(key) ||
      !assessmentId ||
      !evidenceFingerprint ||
      // A nonempty hint only declines batching. Absence still needs locked proof.
      matchStatementRules(next.row.judgment).some(
        (match) => !importOnlyStatementRuleStamps().includes(match.stamp),
      )
    )
      break;
    window.push({ assessmentId, charge: next.charge, evidenceFingerprint });
    positions.push(index);
  }
  const settled = await completeNoActionStatementPrefix(
    db,
    window,
    input.scope,
  );
  const through = settled ? positions[settled - 1]! + 1 : 0;
  for (const next of input.targets.slice(0, through)) {
    const key = chargeId(next.charge);
    if (!input.skipped.has(key)) {
      input.completed.add(key);
      next.row.applicationPending = false;
    }
    input.unfinished.delete(next.row.cursorId);
  }
  return through;
}

async function applyPublishedStatementLabels(
  db: Database,
  input: Parameters<typeof completeNoActionTargets>[1] & {
    scope: StatementSuggestionScope | undefined;
    reconsidered: ReadonlySet<string>;
    fail: (charge: ChargeRef, error: unknown) => void;
  },
) {
  const {
    targets,
    receipts,
    published,
    skipped,
    failedCharges,
    completed,
    unfinished,
    scope,
    reconsidered,
    fail,
  } = input;
  const importId = scope?.importId;
  // Model work may finish out of order; effects admit only the original
  // ready prefix. Later publications keep their receipts for durable resume.
  const applied = new Set<string>();
  const settlementTargets: (typeof targets)[number][] = [];
  const rebuild = new Set<string>();
  // A prior-round completion is resolved unless changed evidence required publication again.
  const awaitsPublication = (key: string) =>
    !completed.has(key) || reconsidered.has(key);
  let applicationBlocked = false;
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    const target = targets[targetIndex]!;
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
      unfinished.add(target.row.cursorId);
      continue;
    }
    try {
      // Import-scoped application regenerates first and may introduce rules.
      // A freshly locked no-rule prefix can bypass rule admission without
      // import authority; its receipt completion still enforces the full scope.
      const settled = importId
        ? 0
        : await completeNoActionTargets(db, {
            targets: targets.slice(
              targetIndex,
              targetIndex + STATEMENT_APPLICATION_PREFIX_LIMIT,
            ),
            receipts,
            published,
            skipped,
            failedCharges,
            completed,
            unfinished,
            scope,
          });
      if (settled) {
        targetIndex += settled - 1;
        continue;
      }
      if (importId) await regenerateCharges(db, [target.charge], scope);
      const outcome = await applyAutomaticRulesForCharge(
        db,
        target.charge,
        Boolean(importId),
        scope,
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
      settlementTargets.push(target);
      if (outcome.applied.length) applied.add(key);
    } catch (error) {
      fail(target.charge, error);
      unfinished.delete(target.row.cursorId);
      applicationBlocked = true;
    }
  }
  const settled = new Set(
    await completeStatementApplications(
      db,
      settlementTargets.map((target) => receipts.get(chargeId(target.charge))!),
      scope,
    ),
  );
  const excluded = new Set<string>();
  for (const target of settlementTargets) {
    const key = chargeId(target.charge);
    if (!settled.has(receipts.get(key)!)) {
      excluded.add(key);
      continue;
    }
    completed.add(key);
    target.row.applicationPending = false;
    unfinished.delete(target.row.cursorId);
  }
  return { applied, rebuild, excluded };
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
    work?: PageWork;
    port?: DecisionPort;
    spendingAdvice?: SpendingAdvicePort;
    /** The Run the model calls are accounted to (a Sweep's step). */
    runId?: RunId | null;
    after?: LabelCursor | null;
    /** Intersect retained charge identity, date and live resolved account scope. */
    scope?: StatementSuggestionScope;
    /** Closed retry population; an empty set selects nothing. */
    retryCharges?: readonly ChargeRef[];
    /**
     * `charge:<source>:<chargeKey>` refs this step generation already counted
     * as failed. An inclusive cursor can reread them; skip so each charge
     * counts once (#3397). "Retry failed" clears the set to re-admit them.
     */
    countedFailures?: ReadonlySet<string>;
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
  const time = <T>(phase: string, work: () => Promise<T>) =>
    withJobPhase(phase, () =>
      input.work ? input.work.time(phase, work) : work(),
    );
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
    JOB_PAGE_LIMITS.suggestionsPerPage,
  );
  const prepareDeadline = Date.now() + 20_000;
  const rows = await time("statement_selection", () =>
    suggestionsNeedingLabels(
      db,
      limit + 1,
      input.after,
      input.scope,
      input.retryCharges,
    ),
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
  const admission = {
    available: () => decisionsLeft > 0,
    reserve() {
      if (decisionsLeft <= 0) return false;
      decisionsLeft--;
      return true;
    },
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
    if (input.countedFailures?.has(`charge:${source}:${chargeKey}`)) return [];
    return [
      { charge: { source, chargeKey }, expected: row.evidenceFingerprint, row },
    ];
  });
  const pendingReceipts = targets.filter(
    (target) => target.row.applicationPending,
  );
  try {
    await repairStatementApplicationReceipts(
      db,
      pendingReceipts.map((target) => ({
        assessmentId: target.row.id,
        charge: target.charge,
      })),
    );
  } catch (error) {
    if (isWorkflowInterrupted(error)) throw error;
    for (const target of pendingReceipts) fail(target.charge, error);
  }
  let stale = 0;
  const skipped = new Set<string>();
  const labelled = new Set<string>();
  const completed = new Set<string>();
  const labels = { reused: 0, generated: 0 };
  const pauses: AiBudgetExhaustedError[] = [];
  const admitTargets = async () => {
    const scope = input.scope;
    if (!scope || !(scope.importId || scope.since || scope.accountIds?.length))
      return;
    const admitted = await statementLabelTargetsInScope(
      db,
      scope,
      targets.map((target) => target.row.id),
    );
    for (const target of targets) {
      const key = chargeId(target.charge);
      if (admitted.has(target.row.id) || skipped.has(key)) continue;
      skipped.add(key);
      skippedIds.push(target.row.id);
      unfinished.delete(target.row.cursorId);
      stale++;
    }
  };
  type ReadyLabels = {
    target: (typeof targets)[number];
    moved: boolean;
    current: ChargeProposal & { amount: number };
  };
  for (let round = 0; round < MAX_LABEL_ROUNDS && targets.length; round++) {
    await admitTargets();
    const proposals = await time("statement_discovery", () =>
      buildPage(
        db,
        targets
          .filter(
            (target) =>
              !target.row.applicationPending &&
              !skipped.has(chargeId(target.charge)) &&
              !failedCharges.has(chargeId(target.charge)),
          )
          .map((target) => target.charge),
        fail,
      ),
    );
    const ready = targets.flatMap<ReadyLabels>((target) => {
      if (target.row.applicationPending) return [];
      const key = chargeId(target.charge);
      if (skipped.has(key)) return [];
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
    const preparations = await time("statement_label_preparation", async () =>
      ready
        .map((entry) => {
          // Failed preparation started no model work; restore this charge's
          // reservations so later charges retain the same admission opportunity.
          const allowanceBeforePreparation = decisionsLeft;
          try {
            const value = prepareLabelledJudgment(db, entry.current, {
              port: input.port,
              spendingAdvice: input.spendingAdvice,
              usage,
              checkpoint: entry.target.row.checkpoint,
              admission,
            });
            if (!value) {
              retainUnfinished(entry.target.row);
              return null;
            }
            return { entry, result: { status: "fulfilled" as const, value } };
          } catch (reason) {
            decisionsLeft = allowanceBeforePreparation;
            return { entry, result: { status: "rejected" as const, reason } };
          }
        })
        .filter((result) => result !== null),
    );
    const prepared = preparations.map(({ result }) => result);
    const preparedReady = preparations.map(({ entry }) => entry);
    const decisions = prepared.flatMap((result) =>
      result.status === "fulfilled"
        ? result.value.decisions.map((decision) => ({
            ...decision,
            reject: result.value.retainError,
          }))
        : [],
    );
    const answers = await time("statement_decisions", () =>
      settleDecisionChoices(decisions, (decision) => decision.args, {
        cooperative: input.cooperative,
      }),
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
      spendingPage = await time("statement_spending_facts", () =>
        prepareStatementSpendingFacts(
          db,
          classified.flatMap((result) =>
            result.status === "fulfilled" ? [result.value.judgment] : [],
          ),
        ),
      );
    } catch (error) {
      if (isWorkflowInterrupted(error)) throw error;
      // Shared discovery is advisory; isolate failures through the existing per-charge path.
    }
    const finish = async () => {
      const usages = new Map<string, DecisionChoiceArgs["usage"]>();
      const usageFor = (operation: string) => {
        let current = usages.get(operation);
        if (!current) {
          current = { db, runId, operation, cacheStatus: "none" };
          usages.set(operation, current);
        }
        return current;
      };
      const finishWave = (wave: typeof classified) =>
        withFieldSuggestionBatch(async () => {
          const settled = await settleDecisionWorkItems(
            wave,
            async (result) => {
              if (result.status !== "fulfilled") return result;
              try {
                if (input.cooperative && Date.now() >= prepareDeadline)
                  result.value.retainError(
                    new AiWorkDeferredError(Date.now() + 1_000),
                  );
                return {
                  status: "fulfilled" as const,
                  value: await result.value.finish(spendingPage, usageFor),
                };
              } catch (reason) {
                return { status: "rejected" as const, reason };
              }
            },
            STATEMENT_SPENDING_CONCURRENCY,
          );
          return settled.map((result) =>
            result.status === "fulfilled" ? result.value : result,
          );
        });
      const computed: Awaited<ReturnType<typeof finishWave>> = [];
      // Batch related field questions within each wave; all started work settles
      // before another wave or publication, so no work outlives this DB scope.
      for (
        let offset = 0;
        offset < classified.length;
        offset += STATEMENT_SPENDING_CONCURRENCY
      )
        computed.push(
          ...(await finishWave(
            classified.slice(offset, offset + STATEMENT_SPENDING_CONCURRENCY),
          )),
        );
      return computed;
    };
    const computed = await time("statement_spending", () =>
      input.cooperative ? withCooperativeAiWork(finish) : finish(),
    );
    const publications = new Map<
      string,
      {
        entry: ReadyLabels;
        input: CompleteStatementLabelPublication;
        retainProgress: () => Promise<boolean>;
      }
    >();
    // Account mappings can change while provider work runs. Recheck the same
    // scope before retaining checkpoints or publishing/application receipts.
    await admitTargets();
    await forEachConcurrently(
      preparedReady.map((entry, index) => ({
        ...entry,
        computed: computed[index]!,
      })),
      // Scoped checkpoint writes share this Job's progress row. Serializing
      // these DB-only writes avoids exhausting snapshot retries on our own page.
      input.scope ? 1 : STATEMENT_PUBLISH_CONCURRENCY,
      async (entry) => {
        const { current, target, computed } = entry;
        if (skipped.has(chargeId(current.charge))) return;
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
            scope: input.scope,
          };
          const retainProgress = async () => {
            // A deferred/zero-budget charge has no new answers to persist.
            // Reused answers are already durable on the selected checkpoint.
            if (!result.labels.generated) return true;
            const saved = await recordStatementLabelCheckpoint(
              db,
              checkpointInput,
            );
            if (saved === "settled" || saved === "out_of_scope") {
              skipped.add(chargeId(current.charge));
              if (saved === "out_of_scope") {
                skippedIds.push(target.row.id);
                unfinished.delete(target.row.cursorId);
                stale++;
              }
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
          try {
            publications.set(chargeId(current.charge), {
              entry,
              input: {
                proposal: await labelledProposal(
                  current,
                  result.checkpoint.judgment,
                ),
                evidenceFingerprint: target.expected,
                checkpoint: result.checkpoint,
                producer: producer(result.model),
              },
              retainProgress,
            });
          } catch (error) {
            await retainFailedStatementPublication(error, retainProgress);
          }
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
    const complete = preparedReady.flatMap(({ current }) => {
      const item = publications.get(chargeId(current.charge));
      return item ? [item] : [];
    });
    const outcomes = await time("statement_publication", () =>
      publishCompleteStatementLabels(
        db,
        complete.map((item) => item.input),
        input.scope,
      ),
    );
    for (const item of complete) {
      const { current, target } = item.entry;
      const key = chargeId(current.charge);
      try {
        const outcome = await completeStatementPublicationResult(
          outcomes.get(key),
          item.retainProgress,
        );
        if (!outcome) {
          skipped.add(key);
          unfinished.delete(target.row.cursorId);
          const result = outcomes.get(key);
          if (result?.kind === "resolved" && result.reason === "out_of_scope") {
            skippedIds.push(target.row.id);
            stale++;
          }
          continue;
        }
        if (outcome.origin === "published") labelled.add(key);
        published.set(key, outcome.receipt.evidenceFingerprint);
        receipts.set(key, outcome.receipt.assessmentId);
        target.row.id = outcome.receipt.assessmentId;
        target.row.judgment = item.input.proposal.judgment;
        target.row.applicationPending = true;
      } catch (error) {
        fail(current.charge, error);
      }
    }
    await admitTargets();
    const { applied, rebuild, excluded } = await time(
      "statement_application",
      () =>
        applyPublishedStatementLabels(db, {
          targets,
          receipts,
          published,
          skipped,
          failedCharges,
          completed,
          unfinished,
          scope: input.scope,
          reconsidered: new Set(
            ready.map(({ current }) => chargeId(current.charge)),
          ),
          fail,
        }),
    );
    for (const target of targets) {
      const key = chargeId(target.charge);
      if (!excluded.has(key)) continue;
      skipped.add(key);
      skippedIds.push(target.row.id);
      unfinished.delete(target.row.cursorId);
      stale++;
    }
    if (rebuild.size && round === MAX_LABEL_ROUNDS - 1) {
      const remaining = targets.filter((target) =>
        rebuild.has(chargeId(target.charge)),
      );
      await regenerateCharges(
        db,
        remaining.map((target) => target.charge),
        input.scope,
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
          input.scope,
        );
      if (pauses[0] && !input.cooperative) throw pauses[0];
      break;
    }
    if (!applied.size && !rebuild.size) break;
  }
  return {
    labelled: labelled.size,
    // A charge that settled in an earlier round and then failed counts once.
    completed: [...completed].filter((key) => !failedCharges.has(key)).length,
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

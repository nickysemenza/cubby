import type { FinancialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { financialTransactionKind } from "@cubby/schemas/financial-transaction";
import type { RunId } from "@cubby/schemas/identifiers";
import type { RunStepError } from "@cubby/schemas/run-step";
import { statementSpendingAnswersComplete } from "@cubby/schemas/statement-answers";
import {
  statementCounterparty,
  type StatementTransactionJudgment,
  type StatementAnswers,
} from "@cubby/schemas/statement-suggestion";
import { suggestionSubjects } from "@cubby/schemas/suggestion";
import { JOB_PAGE_LIMITS } from "@cubby/shared/job-page-limits";
import { createLogger } from "@cubby/worker-tracing";

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
import { aiRunOwner } from "~/server/ai/policy/call-owner";
import {
  STATEMENT_CHARGE_IDENTITY_FEATURE,
  STATEMENT_COUNTERPARTY_FEATURE,
  STATEMENT_TRANSACTION_KIND_FEATURE,
} from "~/server/ai/policy/features";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { type FinancialSpendingPage } from "~/server/domains/financial-transaction/repo/financial-spending";
import { prepareFinancialStatementPreview } from "~/server/domains/financial-transaction/repo/financial-statement-preview";
import {
  adviseSpending,
  needsSpendingAdvice,
  type SpendingAdvicePort,
} from "~/server/domains/financial-transaction/service/spending-advice";
import { statementRecommendation } from "~/server/domains/transaction-import/repo/statement-charge";
import {
  statementLabelSubject,
  statementCandidateSubject,
  mergeStatementAnswers,
  statementAnswerVersions,
} from "~/server/domains/transaction-import/repo/statement-label-input";
import { prepareStatementSpendingFacts } from "~/server/domains/transaction-import/repo/statement-spending";
import {
  chargeId,
  type ChargeRef,
  publishAndSettleStatementCharges,
  suggestionsNeedingLabels,
  repairStatementApplicationReceipts,
  statementLabelTargetsInScope,
  type StatementSuggestionScope,
  type LabelCursor,
  recordStatementAnswers,
} from "~/server/domains/transaction-import/repo/statement-suggestions";
import { decideStatementKind } from "~/server/domains/transaction-import/repo/statement-transaction-kind";
import { withJobPhase } from "~/server/generic/jobs/context";
import type { JobDeferredError } from "~/server/generic/jobs/errors";
import type { PageWork } from "~/server/generic/jobs/page-work";
import { buildCrudServices } from "~/server/http/request-context";
import { canonicalJson } from "~/server/lib/canonical-json";
import { isWorkflowInterrupted } from "~/server/workflows/runs/execution";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

// Page time is dominated by sequential batched model round trips, which cost
// about the same for 32 or 128 charges; the cooperative budget bounds the claim.
const STATEMENT_LABEL_BATCH = 128;
// Admit one default page together so a slow merchant does not serialize four waves.
// Larger explicit pages still retain a bounded wave and the cooperative budget.
export const STATEMENT_SPENDING_CONCURRENCY = 128;
const log = createLogger("statement-suggestion-labels");

const identityLabel = {
  same_charge: "same",
  different_charge: "different",
  insufficient_evidence: "insufficient",
} as const;

type LabelPreparation = {
  charge: ChargeRef;
  judgment: StatementTransactionJudgment;
  evidenceFingerprint: string;
  amount: number;
};

/** Model work supplies answers; generation owns judgments and publication. */
function prepareLabelledJudgment(
  db: Database,
  current: LabelPreparation,
  input: {
    port?: DecisionPort;
    spendingAdvice?: SpendingAdvicePort;
    usage: DecisionChoiceArgs["usage"];
    answers: StatementAnswers;
    isLoan: boolean;
    admission: {
      available(): boolean;
      reserve(): boolean;
    };
  },
) {
  const answers = mergeStatementAnswers(
    current.judgment,
    [input.answers],
    input.isLoan,
  );
  const judgment = structuredClone(current.judgment);
  for (const candidate of judgment.candidates)
    candidate.label =
      answers.candidates[candidate.transactionId]?.value ?? null;
  if (judgment.create) {
    judgment.create.votes.label = answers.kind?.value ?? null;
    judgment.create.counterparty.label = answers.counterparty?.value ?? null;
  }
  const countLabels = () =>
    Object.keys(answers.candidates).length +
    Number(!!answers.kind) +
    Number(!!answers.counterparty) +
    Number(!!answers.escrow) +
    Number(!!answers.merchant);
  const reused = countLabels();
  const before = canonicalJson(answers);
  let spendingComplete = !needsSpendingAdvice(judgment);
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
    if (answers.candidates[candidate.transactionId]) continue;
    if (!input.admission.available()) break;
    const prompt = STATEMENT_CHARGE_IDENTITY_FEATURE.prompt(
      JSON.stringify({
        statement,
        transaction: statementCandidateSubject(candidate),
      }),
    );
    if (!decisionChoiceFitsContext(prompt)) {
      retainError(
        new Error("Statement identity question exceeds the decision context"),
      );
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
        const choice =
          STATEMENT_CHARGE_IDENTITY_FEATURE.choices[result.selectedIndex ?? -1];
        candidate.label = {
          same: choice ? identityLabel[choice] : "insufficient",
          confidence: result.confidence,
          model,
        };
        answers.candidates[candidate.transactionId] = {
          value: candidate.label,
          input: {
            statement,
            transaction: statementCandidateSubject(candidate),
          },
          versions: { ...statementAnswerVersions.candidates },
          models: [model],
        };
      },
    });
  }
  // Both votes use the original statement evidence, independently of identity
  // answers and of each other. Enqueue them with the whole page's questions.
  for (const part of ["kind", "counterparty"] as const) {
    if (!judgment.create || judgment.transfer || answers[part]) continue;
    if (!input.admission.available()) break;
    const feature =
      part === "kind"
        ? STATEMENT_TRANSACTION_KIND_FEATURE
        : STATEMENT_COUNTERPARTY_FEATURE;
    const prompt = feature.prompt(JSON.stringify(statement));
    const apply = (choice: string | null, models: string[]) => {
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
      Object.assign(answers, {
        [part]: {
          value:
            part === "kind"
              ? judgment.create.votes.label
              : judgment.create.counterparty.label,
          input: statement,
          versions: { ...statementAnswerVersions[part] },
          models,
        },
      });
    };
    if (!decisionChoiceFitsContext(prompt)) {
      retainError(
        new Error("Statement label question exceeds the decision context"),
      );
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
        const choice = feature.choices[result.selectedIndex ?? -1];
        apply(choice && result.confidence === "high" ? choice : null, [
          decisionModelFor(args),
        ]);
      },
    });
  }
  // Reserve spending before preparing the next charge, preserving the original
  // identity/kind/counterparty/spending order. Context defaults reserve nothing.
  const spendingReserved =
    needsSpendingAdvice(judgment) &&
    !!judgment.create &&
    !statementSpendingAnswersComplete(judgment.create, input.isLoan, answers);
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
            descriptor: judgment.create,
          }),
        );
    },
    /**
     * The spending advice this charge plans with, after any model work, or
     * `undefined` when it plans nothing; the caller plans a wave at once.
     */
    async advise(
      page?: FinancialSpendingPage,
      usageFor?: Parameters<typeof adviseSpending>[1]["usageFor"],
    ): Promise<{ advice: FinancialSpendingAdvice | null } | undefined> {
      // Plan spending for the action that publishes, so apply replans the
      // same target it compares against.
      judgment.recommended = statementRecommendation(judgment);
      if (
        !needsSpendingAdvice(judgment) ||
        (judgment.create &&
          statementSpendingAnswersComplete(
            judgment.create,
            input.isLoan,
            answers,
          ))
      ) {
        spendingComplete = true;
        return { advice: null };
      }
      if (
        !errors.length &&
        waitingUntil === null &&
        (spendingReserved ? spendingAdmitted : input.admission.reserve())
      ) {
        try {
          const spending = await withAiInputs(false, () =>
            adviseSpending(db, {
              judgment,
              answers,
              owner: aiRunOwner(input.usage!.runId),
              port: input.port,
              spendingAdvice: input.spendingAdvice,
              preparation: page,
              usageFor,
            }),
          );
          spendingComplete = true;
          if (spending.result) {
            Object.assign(answers, spending.result.answers);
            return { advice: spending.result.advice };
          }
          return { advice: null };
        } catch (error) {
          retainError(error);
        }
      }
      return undefined;
    },
    complete() {
      return {
        answers,
        labels: {
          reused,
          generated:
            canonicalJson(answers) === before
              ? 0
              : Math.max(1, countLabels() - reused),
        },

        errors,
        waitingUntil,
        complete:
          spendingComplete &&
          judgment.candidates.every(
            (candidate) => !!answers.candidates[candidate.transactionId],
          ) &&
          (!judgment.create ||
            !!judgment.transfer ||
            (!!answers.kind && !!answers.counterparty)),
      };
    },
  };
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
    /** When the step recorded its last page: later applications were never refreshed. */
    recoverSince?: Date | null;
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
  /** `charge:` refs of the page's receipts left for a later page. */
  unfinishedRefs: string[];
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
    unfinishedRefs: [],
    waitingUntil: null,
    paused: null,
  };
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled && !input.port) return { ...empty, active: false };
  const limit = Math.min(
    input.limit ??
      (input.scope?.importId
        ? JOB_PAGE_LIMITS.statementApplicationsPerPage
        : STATEMENT_LABEL_BATCH),
    JOB_PAGE_LIMITS.suggestionsPerPage,
  );
  // A page that stops early re-pays selection, admission and discovery for the
  // same charges on the next page, so the budget only guards the Job lease.
  const budgetEnds = input.cooperative
    ? Date.now() + JOB_PAGE_LIMITS.cooperativePageBudgetMs
    : null;
  const budgetSpent = () => budgetEnds !== null && Date.now() >= budgetEnds;
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
  const runId = input.runId ?? null;
  const usage = {
    db,
    runId: runId ?? undefined,
    operation: "statement-suggestion-label",
  };
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
    const subject = suggestionSubjects.statement_transaction.safeParse(
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
        suggestionId: target.row.id,
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
  const pauses: JobDeferredError[] = [];
  // Admission resolves account-wide evidence, so each call is one preparation.
  // A round admits twice: before model work, so nothing out of scope is paid
  // for, and after it, because provider waits let account mappings move. The
  // writes that follow (publication, application) enforce the scope in their
  // own transactions, and a ledger write in this pass only happens in
  // application, whose next round admits again.
  const admitTargets = async (
    preparation?: Awaited<ReturnType<typeof prepareFinancialStatementPreview>>,
  ) => {
    const scope = input.scope;
    if (!scope || !(scope.importId || scope.since || scope.accountIds?.length))
      return;
    const live = targets.filter(
      (target) => !skipped.has(chargeId(target.charge)),
    );
    if (!live.length) return;
    const admitted = await statementLabelTargetsInScope(
      db,
      scope,
      live.map((target) => target.row.id),
      preparation,
    );
    for (const target of live) {
      const key = chargeId(target.charge);
      if (admitted.has(target.row.id)) continue;
      skipped.add(key);
      skippedIds.push(target.row.id);
      unfinished.delete(target.row.cursorId);
      stale++;
    }
  };
  type ReadyLabels = {
    target: (typeof targets)[number];
    moved: boolean;
    current: LabelPreparation;
  };
  for (let round = 0; round < 1 && targets.length; round++) {
    const preparation = await prepareFinancialStatementPreview(db);
    await admitTargets(preparation);
    const ready: ReadyLabels[] = targets
      .filter(
        (target) =>
          !target.row.applicationPending &&
          !skipped.has(chargeId(target.charge)),
      )
      .map((target) => ({
        target,
        moved: false,
        current: {
          charge: target.charge,
          judgment: target.row.judgment,
          evidenceFingerprint: target.expected,
          amount: target.row.amount,
        },
      }));
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
    // before answer persistence and publication.
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
              answers: entry.target.row.answers,
              isLoan:
                preparation.accounts.find(
                  (account) => account.id === entry.current.judgment.accountId,
                )?.identity.kind === "loan",
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
          current = {
            db,
            runId: runId ?? undefined,
            operation,
            cacheStatus: "none",
          };
          usages.set(operation, current);
        }
        return current;
      };
      const finishWave = (wave: typeof classified) =>
        withFieldSuggestionBatch(async () => {
          const advised = await settleDecisionWorkItems(
            wave,
            async (result) => {
              if (result.status !== "fulfilled") return result;
              try {
                if (budgetSpent())
                  result.value.retainError(
                    new AiWorkDeferredError(Date.now() + 1_000),
                  );
                return {
                  status: "fulfilled" as const,
                  value: {
                    labels: result.value,
                    advised: await result.value.advise(spendingPage, usageFor),
                  },
                };
              } catch (reason) {
                return { status: "rejected" as const, reason };
              }
            },
            STATEMENT_SPENDING_CONCURRENCY,
          );
          return advised.map((result) => {
            if (result.status !== "fulfilled") return result;
            const inner = result.value;
            if (inner.status !== "fulfilled") return inner;
            return {
              status: "fulfilled" as const,
              value: inner.value.labels.complete(),
            };
          });
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
    await admitTargets();
    const readyCharges: ChargeRef[] = targets
      .filter((t) => t.row.applicationPending)
      .map((t) => t.charge);
    for (const [index, entry] of preparedReady.entries()) {
      const result = computed[index]!;
      if (skipped.has(chargeId(entry.current.charge))) continue;
      if (result.status === "rejected") {
        fail(entry.current.charge, result.reason);
        continue;
      }
      labels.reused += result.value.labels.reused;
      labels.generated += result.value.labels.generated;
      try {
        if (result.value.labels.generated) {
          const saved = await recordStatementAnswers(db, {
            charge: entry.current.charge,
            answers: result.value.answers,
            scope: input.scope,
          });
          if (saved !== "saved") {
            skipped.add(chargeId(entry.current.charge));
            skippedIds.push(entry.target.row.id);
            stale++;
            continue;
          }
        }
        if (result.value.errors.length) {
          fail(entry.current.charge, new AggregateError(result.value.errors));
          continue;
        }
        if (!result.value.complete || result.value.waitingUntil !== null) {
          retainUnfinished(entry.target.row);
          waitingUntil = result.value.waitingUntil;
          continue;
        }
        readyCharges.push(entry.current.charge);
        labelled.add(chargeId(entry.current.charge));
      } catch (error) {
        fail(entry.current.charge, error);
      }
    }
    // Settlement admits only the ready prefix; later paid answers are already durable.
    const readyKeys = new Set(readyCharges.map(chargeId));
    const prefix: ChargeRef[] = [];
    let stopped = false;
    for (const target of targets) {
      const key = chargeId(target.charge);
      if (skipped.has(key)) continue;
      if (failedCharges.has(key) || !readyKeys.has(key)) stopped = true;
      if (stopped) {
        if (!failedCharges.has(key)) retainUnfinished(target.row);
      } else prefix.push(target.charge);
    }
    if (prefix.length) {
      const result = await publishAndSettleStatementCharges(db, {
        charges: prefix,
        scope: input.scope,
        runId,
        servicesFor: buildCrudServices,
        mode: "label",
        budgetSpent,
        time,
      });
      for (const charge of prefix) {
        const key = chargeId(charge);
        const target = targets.find((t) => chargeId(t.charge) === key)!;
        const outcome = result.settlement.get(key);
        if (outcome?.kind === "failed") fail(charge, outcome.error);
        else if (
          !outcome ||
          outcome.kind === "unfinished" ||
          outcome.kind === "moved"
        )
          retainUnfinished(target.row);
        else {
          completed.add(key);
          unfinished.delete(target.row.cursorId);
        }
      }
      for (const error of result.failed) failed.push(error);
    }
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
    unfinishedRefs: page.flatMap((row) => {
      if (!unfinished.has(row.cursorId)) return [];
      const subject = suggestionSubjects.statement_transaction.safeParse(
        row.subject,
      );
      return subject.success
        ? [`charge:${subject.data.source}:${subject.data.chargeKey}`]
        : [];
    }),
    active: true,
    waitingUntil,
    paused: pauses[0]
      ? { reason: pauses[0].message, until: pauses[0].until.toISOString() }
      : null,
  };
}

export function labelStatementSuggestions(
  db: Database,
  input: Parameters<typeof runStatementLabelBatch>[1] = {},
) {
  return runStatementLabelBatch(db, input);
}

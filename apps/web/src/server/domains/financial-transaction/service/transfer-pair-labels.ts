import type { RunId } from "@cubby/schemas/identifiers";
import type { RunStepError } from "@cubby/schemas/run-step";
import type { TransferPairLeg } from "@cubby/schemas/transfer-pair-suggestion";
import {
  selectDecisionModel,
  type SupportedDecisionModel,
} from "@cubby/shared/ai/models";
import { WORKFLOW_EXECUTION_LIMITS } from "@cubby/shared/workflow-limits";

import { createConcurrencyLimiter } from "~/lib/concurrency-limiter";
import { AiBudgetExhaustedError } from "~/server/ai/budget";
import { aiWorkDeferral } from "~/server/ai/cooperative-work";
import {
  decisionChoiceFitsContext,
  type DecisionPort,
  settleDecisionChoices,
  type DecisionChoiceArgs,
} from "~/server/ai/decision-model";
import { TRANSFER_PAIR_MOVEMENT_FEATURE } from "~/server/ai/policy/features";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import {
  buildTransferPair,
  labelTransferPair,
  publishTransferPair,
  transferPairEvidenceFingerprint,
  transferPairsNeedingLabels,
  type TransferPairLabelCursor,
} from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

/** One label page labels at most this many pairs. */
const TRANSFER_PAIR_LABEL_BATCH = WORKFLOW_EXECUTION_LIMITS.suggestionsPerPage;
/** Database work only; model calls never occupy this lane. */
const TRANSFER_PAIR_PUBLISH_CONCURRENCY = 4;

type Question = DecisionChoiceArgs;
type Usage = Question["usage"];

/** One leg's movement reading in its pair; only the leg and the opposite account's kind are evidence. */
function movementQuestion(
  leg: TransferPairLeg,
  opposite: TransferPairLeg,
  context: { model: SupportedDecisionModel; port?: DecisionPort; usage: Usage },
): Question | null {
  const prompt = TRANSFER_PAIR_MOVEMENT_FEATURE.prompt(
    JSON.stringify({
      account: { kind: leg.accountKind, name: leg.accountName },
      oppositeAccountKind: opposite.accountKind,
      amount: leg.amount,
      date: leg.date,
      descriptor: leg.description,
      merchant: leg.merchant,
      providerCategory: leg.signals.providerCategory,
      recordedKind: leg.origin === "transaction" ? leg.signals.kind : null,
    }),
  );
  if (!decisionChoiceFitsContext(prompt)) return null;
  return {
    ...prompt,
    feature: TRANSFER_PAIR_MOVEMENT_FEATURE,
    decisionModel: context.model,
    port: context.port,
    usage: context.usage,
  };
}

/**
 * Label pending rule pairs with the movement decision for each leg, then
 * republish them. Labels are advisory: a confident `account_move` on both
 * legs only lifts `weak_movement`, and every structural blocker remains.
 * Respects the automatic-work switch that gates AI refresh. With `runId`,
 * labels only that Run's pairs (publication moves a rediscovered pair to the
 * Run that confirmed it).
 */
export async function labelTransferPairSuggestions(
  db: Database,
  input: {
    limit?: number;
    cooperative?: boolean;
    port?: DecisionPort;
    /** The Run the model calls are accounted to, and whose pairs are labelled. */
    runId?: RunId | null;
    after?: TransferPairLabelCursor | null;
  } = {},
): Promise<{
  labelled: number;
  /** Pairs whose evidence moved since publication; regeneration relabels them. */
  stale: number;
  failed: RunStepError[];
  next: TransferPairLabelCursor | null;
  /** False when the automatic-work switch is off, so nothing was asked. */
  active: boolean;
  waitingUntil: number | null;
}> {
  const empty = {
    labelled: 0,
    stale: 0,
    failed: [],
    next: null,
    waitingUntil: null,
  };
  const activation = await readAiRefreshActivation(db);
  if (!activation?.enabled && !input.port) return { ...empty, active: false };
  const limit = Math.min(
    input.limit ?? TRANSFER_PAIR_LABEL_BATCH,
    TRANSFER_PAIR_LABEL_BATCH,
  );
  const rows = await transferPairsNeedingLabels(db, {
    limit: limit + 1,
    after: input.after,
    runId: input.runId,
  });
  if (!rows.length) return { ...empty, active: true };
  const runId =
    input.runId ??
    (await ensureRun(db, systemActor(), { purpose: "background" }));
  const usage = { db, runId, operation: "transfer-pair-label" };
  const failed: RunStepError[] = [];
  const pauses: AiBudgetExhaustedError[] = [];
  let labelled = 0;
  let stale = 0;
  const page = rows.slice(0, limit);
  let unfinished = Infinity;
  let waitingUntil: number | null = null;
  const database = createConcurrencyLimiter(TRANSFER_PAIR_PUBLISH_CONCURRENCY);
  const signal = new AbortController().signal;
  const recordFailure = (index: number, error: unknown) => {
    const row = page[index]!;

    const deferred = aiWorkDeferral(error);
    if (deferred) {
      unfinished = Math.min(unfinished, index);
      waitingUntil = Math.min(waitingUntil ?? Infinity, deferred.until);
      return;
    }
    // The budget pauses the whole pass; any other failure is this pair's.
    if (error instanceof AiBudgetExhaustedError) pauses.push(error);
    else
      failed.push({
        at: new Date().toISOString(),
        message: runFailureText(error instanceof Error ? error : String(error)),
        ref: `transfer_pair:${row.data.pairKey}`,
      });
  };
  const prepared = await Promise.all(
    page.map(async (row, index) => {
      try {
        const current = await database.run(
          () => buildTransferPair(db, row.data.pairKey),
          signal,
        );
        if (
          !current ||
          (await transferPairEvidenceFingerprint(current.judgment)) !==
            row.data.evidenceFingerprint
        ) {
          stale++;
          return null;
        }
        const model = selectDecisionModel({ key: row.data.pairKey });
        return { current, model, index };
      } catch (error) {
        recordFailure(index, error);
        return null;
      }
    }),
  );
  const ready = prepared
    .filter((item) => item !== null)
    .map((item) => {
      const labels: Parameters<typeof labelTransferPair>[1] = {
        outflow: null,
        inflow: null,
      };
      const errors: unknown[] = [];
      return { ...item, labels, errors };
    });
  const questions = ready.flatMap((pair) => {
    const { outflow, inflow } = pair.current.judgment;
    const context = { model: pair.model, port: input.port, usage };
    return (["outflow", "inflow"] as const).flatMap((leg) => {
      const args = movementQuestion(
        leg === "outflow" ? outflow : inflow,
        leg === "outflow" ? inflow : outflow,
        context,
      );
      return args ? [{ pair, leg, args }] : [];
    });
  });
  const answers = await settleDecisionChoices(
    questions,
    (question) => question.args,
    { cooperative: input.cooperative },
  );
  for (const answer of answers) {
    const { pair, leg } = answer.item;
    if (answer.status === "rejected") {
      pair.errors.push(answer.reason);
      continue;
    }
    const choice =
      TRANSFER_PAIR_MOVEMENT_FEATURE.choices[answer.value.selectedIndex ?? -1];
    pair.labels[leg] = choice
      ? { choice, confidence: answer.value.confidence, model: pair.model }
      : null;
  }
  await Promise.all(
    ready.map(async (item) => {
      const { current, model, index } = item;
      try {
        if (item.errors.length)
          throw (
            item.errors.find(
              (error) => error instanceof AiBudgetExhaustedError,
            ) ?? item.errors[0]
          );
        await database.run(async () => {
          const outcome = await publishTransferPair(
            db,
            {
              ...current,
              judgment: labelTransferPair(current.judgment, {
                outflow: item.labels.outflow,
                inflow: item.labels.inflow,
              }),
            },
            {
              kind: "model",
              model,
              revision: TRANSFER_PAIR_MOVEMENT_FEATURE.promptVersion,
              runId,
              evaluationId: null,
            },
          );
          if (outcome === "published") {
            labelled++;
            const charges = [
              current.judgment.outflow,
              current.judgment.inflow,
            ].flatMap((leg) => (leg.charge ? [leg.charge] : []));
            const { regenerateCharges } =
              await import("~/server/domains/statement-import/repo/statement-suggestions");
            await regenerateCharges(db, charges);
          }
        }, signal);
      } catch (error) {
        recordFailure(index, error);
      }
    }),
  );
  if (pauses[0]) throw pauses[0];
  const last = page.at(-1);
  // Resume before the earliest deferred pair. A null cursor with a wake time
  // means retry from the start, not completion; published pairs leave the queue.
  const before = page[unfinished - 1];
  return {
    labelled,
    stale,
    failed,
    next: Number.isFinite(unfinished)
      ? before
        ? { createdAt: before.createdAt, id: before.id }
        : (input.after ?? null)
      : rows.length > limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
    active: true,
    waitingUntil,
  };
}

import type { RunId } from "@cubby/schemas/identifiers";
import type { RunStepError } from "@cubby/schemas/run-step";
import type {
  TransferPairLeg,
  TransferPairMovementLabel,
} from "@cubby/schemas/transfer-pair-suggestion";
import {
  selectDecisionModel,
  type SupportedDecisionModel,
} from "@cubby/shared/ai/models";

import {
  createConcurrencyLimiter,
  forEachConcurrently,
} from "~/lib/concurrency-limiter";
import { AiBudgetExhaustedError, settleDecisions } from "~/server/ai/budget";
import {
  aiWorkDeferral,
  withCooperativeAiWork,
} from "~/server/ai/cooperative-work";
import {
  decisionChoiceFitsContext,
  type DecisionPort,
  runDecisionChoice,
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
const TRANSFER_PAIR_LABEL_BATCH = 100;
/** Database work only; model calls never occupy this lane. */
const TRANSFER_PAIR_PUBLISH_CONCURRENCY = 4;

type Usage = Parameters<typeof runDecisionChoice>[0]["usage"];

/** One leg's movement reading in its pair; only the leg and the opposite account's kind are evidence. */
async function movementLabel(
  leg: TransferPairLeg,
  opposite: TransferPairLeg,
  context: { model: SupportedDecisionModel; port?: DecisionPort; usage: Usage },
): Promise<TransferPairMovementLabel | null> {
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
  const result = await runDecisionChoice({
    ...prompt,
    feature: TRANSFER_PAIR_MOVEMENT_FEATURE,
    decisionModel: context.model,
    port: context.port,
    usage: context.usage,
  });
  const choice =
    TRANSFER_PAIR_MOVEMENT_FEATURE.choices[result.selectedIndex ?? -1];
  return choice
    ? { choice, confidence: result.confidence, model: context.model }
    : null;
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
  const limit = input.limit ?? TRANSFER_PAIR_LABEL_BATCH;
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
  await forEachConcurrently(page, page.length, async (row) => {
    if (pauses.length) return;
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
        return;
      }
      const model = selectDecisionModel({ key: row.data.pairKey });
      const { outflow, inflow } = current.judgment;
      const context = { model, port: input.port, usage };
      const compute = () =>
        settleDecisions([
          movementLabel(outflow, inflow, context),
          movementLabel(inflow, outflow, context),
        ]);
      const [outflowLabel, inflowLabel] = await (input.cooperative
        ? withCooperativeAiWork(compute)
        : compute());
      await database.run(async () => {
        const outcome = await publishTransferPair(
          db,
          {
            ...current,
            judgment: labelTransferPair(current.judgment, {
              outflow: outflowLabel ?? null,
              inflow: inflowLabel ?? null,
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
          const charges = [outflow, inflow].flatMap((leg) =>
            leg.charge ? [leg.charge] : [],
          );
          const { regenerateCharges } =
            await import("~/server/domains/statement-import/repo/statement-suggestions");
          await regenerateCharges(db, charges);
        }
      }, signal);
    } catch (error) {
      const deferred = aiWorkDeferral(error);
      if (deferred) {
        unfinished = Math.min(unfinished, page.indexOf(row));
        waitingUntil = Math.min(waitingUntil ?? Infinity, deferred.until);
        return;
      }
      // The budget pauses the whole pass; any other failure is this pair's.
      if (error instanceof AiBudgetExhaustedError) pauses.push(error);
      else
        failed.push({
          at: new Date().toISOString(),
          message: runFailureText(
            error instanceof Error ? error : String(error),
          ),
          ref: `transfer_pair:${row.data.pairKey}`,
        });
    }
  });
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

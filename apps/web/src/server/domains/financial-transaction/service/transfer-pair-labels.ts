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

import { forEachConcurrently } from "~/lib/concurrency-limiter";
import { AiBudgetExhaustedError, settleDecisions } from "~/server/ai/budget";
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
/** Pairs labelled at once; each holds a pooled connection to publish. */
const TRANSFER_PAIR_LABEL_CONCURRENCY = 4;

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
}> {
  const empty = { labelled: 0, stale: 0, failed: [], next: null };
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
  await forEachConcurrently(
    page,
    TRANSFER_PAIR_LABEL_CONCURRENCY,
    async (row) => {
      if (pauses.length) return;
      try {
        const current = await buildTransferPair(db, row.data.pairKey);
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
        const [outflowLabel, inflowLabel] = await settleDecisions([
          movementLabel(outflow, inflow, context),
          movementLabel(inflow, outflow, context),
        ]);
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
        if (outcome === "published") labelled++;
      } catch (error) {
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
    },
  );
  if (pauses[0]) throw pauses[0];
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

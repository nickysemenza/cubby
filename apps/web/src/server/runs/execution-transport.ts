import type { RunId } from "@cubby/schemas/identifiers";
import {
  workersAiModel,
  type GatewayFetchRoutes,
} from "@cubby/shared/ai/gateway-request";
import {
  supportedDecisionModelSchema,
  providerFor,
} from "@cubby/shared/ai/models";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { quoteAiDecisionRequestUsd } from "~/server/ai/pricing";
import type { Database } from "~/server/db";
import { run } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import {
  assertExecutionAuthorization,
  reserveExecutionAuthorization,
} from "./execution-authorization";
import {
  executionAuthorizationFromInput,
  executionRequestForRun,
  pauseExecutionRun,
} from "./execution-context";

const decisionQuestions = z.object({
  questions: z.record(z.string(), z.unknown()),
});

/** Each physical decision attempt reserves its complete bill before transmission. */
export function paidDecisionPreflight(
  db: Database,
  runId: RunId,
): NonNullable<GatewayFetchRoutes["beforePaidRequest"]> {
  return async (request) => {
    const authority = await executionRequestForRun(db, runId, {
      requireRunning: true,
    });
    if (!authority)
      throw new Error(
        "Paid research requires an explicit execution authorization.",
      );
    await assertExecutionAuthorization(db, authority);
    const assertCurrentRun = async () => {
      const [current] = await getDb(db)
        .select({
          status: run.status,
          retiredAt: run.retiredAt,
          input: run.input,
          actorUserId: run.actorUserId,
          ledgerPartyId: run.ledgerPartyId,
        })
        .from(run)
        .where(and(eq(run.id, runId), notDeleted(run)))
        .limit(1);
      if (!current || current.retiredAt || current.status !== "running")
        throw new Error("Execution authorization Run is no longer executable.");
      const ref = executionAuthorizationFromInput(current.input);
      if (
        ref?.runId !== authority.ref.runId ||
        ref.approvalFingerprint !== authority.ref.approvalFingerprint ||
        current.actorUserId !== authority.owner.userId ||
        current.ledgerPartyId !== authority.owner.ledgerPartyId
      )
        throw new Error("Execution authorization Run binding changed.");
    };
    const model = supportedDecisionModelSchema.parse(
      workersAiModel(request.endpoint),
    );
    const questions = decisionQuestions.parse(await request.query()).questions;
    const quote = await quoteAiDecisionRequestUsd({
      provider: providerFor(model),
      model,
      questionCount: Object.keys(questions).length,
    });
    if (!quote)
      throw new Error(
        "Paid research allowance cannot price this decision's full billing bounds.",
      );
    const reservationMicroUSD = Math.ceil(quote.maxCostUsd * 1_000_000);
    if (!Number.isSafeInteger(reservationMicroUSD))
      throw new Error(
        "Paid research allowance exceeds safe integer accounting.",
      );
    await assertCurrentRun();
    if (reservationMicroUSD === 0) return;
    const decision = await reserveExecutionAuthorization(db, {
      ...authority,
      physicalAttemptId: crypto.randomUUID(),
      reservationMicroUSD,
    });
    if (decision.status === "refused") {
      const message = `Paid research allowance refused: ${decision.reason}.`;
      if (decision.reason === "budget_exhausted")
        await pauseExecutionRun(db, runId, message);
      throw new Error(message);
    }
    // The final admission read is the cancellation boundary. Keep a committed
    // reservation when cancellation wins here; it must never grant a retry.
    await assertCurrentRun();
  };
}

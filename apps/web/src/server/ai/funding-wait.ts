import type { RunId } from "@cubby/schemas/identifiers";

import {
  AiBudgetExhaustedError,
  assertAiBudget,
  paidFundingStopMessage,
  readAiBudget,
} from "~/server/ai/budget";
import type { Database } from "~/server/db";

/** Admit paid work against its Run's confirmed allowance. */
export async function admitPaid(db: Database, call: { runId?: RunId }) {
  try {
    const allowance = call.runId
      ? ((await (
          await import("~/server/ai/funding")
        ).readPaidAllowance(db, call.runId)) ?? 0)
      : 0;
    await assertAiBudget(db, allowance);
  } catch (error) {
    if (call.runId && error instanceof AiBudgetExhaustedError)
      await (
        await import("~/server/domains/run/repo/execution-context")
      ).pauseForFunding(db, call.runId, error);
    throw error;
  }
}

/** Preserve the raw refusal and fence a stale Run report when given its generation. */
export async function stopForFunding(
  db: Database,
  runId: RunId | undefined,
  raw: string,
  generation?: string | null,
) {
  const status = await readAiBudget(db);
  const stop = new AiBudgetExhaustedError(
    status,
    paidFundingStopMessage(raw, status),
  );
  if (runId)
    await (
      await import("~/server/domains/run/repo/execution-context")
    ).pauseForFunding(db, runId, stop, generation);
  return stop;
}

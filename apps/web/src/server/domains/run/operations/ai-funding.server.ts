import { aiFundingContract } from "~/contracts/ai.contract";
import { setAiBudget } from "~/server/ai/budget";
import { readAiFundingStatus, resetFundingRefusal } from "~/server/ai/funding";
import { resumeFundingPausedRuns } from "~/server/ai/funding-wait";
import type { AuthenticatedRequestContext } from "~/server/http/request-context";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

async function assertMember(context: AuthenticatedRequestContext) {
  if (!(await context.currentParty()))
    throw new Error("This login is not linked to a member ledger party yet.");
}

/**
 * Funding changes let a refused source answer again, so work paused for
 * funding under the old state retries now; anything still without capacity
 * pauses again before spending.
 */
async function fundingChanged(context: AuthenticatedRequestContext) {
  await resumeFundingPausedRuns(context.db, { anyWindow: true });
  return readAiFundingStatus(context.db);
}

export const aiFundingHandlers = implementOperationDomain(aiFundingContract, {
  status: async (context) => readAiFundingStatus(context.db),
  setBudget: async (context, input) => {
    await assertMember(context);
    await setAiBudget(context.db, input);
    return fundingChanged(context);
  },
  resetFundingRefusal: async (context, input) => {
    await assertMember(context);
    await resetFundingRefusal(input.source);
    return fundingChanged(context);
  },
});

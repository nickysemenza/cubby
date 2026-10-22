import { runDetailContract } from "~/contracts/run-detail.contract";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

import { readRunDecisions, readRunDetailSteps } from "../repo/run-detail";

export const runDetailHandlers = implementOperationDomain(runDetailContract, {
  steps: (context, input) => readRunDetailSteps(context.db, input.runId),
  decisions: (context, input) =>
    readRunDecisions(context.db, input.runId, input.family),
});

import { runDetailContract } from "~/contracts/run-detail.contract";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

import { readRunDecisions, readRunDetailSteps } from "../repo/run-detail";
import { readRunEvaluationsByCode } from "../repo/run-evaluations";

export const runDetailHandlers = implementOperationDomain(runDetailContract, {
  steps: (context, input) => readRunDetailSteps(context.db, input.runId),
  evaluations: (context, input) =>
    readRunEvaluationsByCode(context.db, input.runId, input.failedOnly),
  decisions: (context, input) =>
    readRunDecisions(context.db, input.runId, input.family),
});

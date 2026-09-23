import { runContract } from "~/contracts/run.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getImportRunByShortcode } from "~/server/repo/import-run";
import { listRunAiUsageWorkflow } from "~/server/workflows/ai.server";

export const runHandlers = implementOperationDomain(runContract, {
  detail: (context, input) =>
    getImportRunByShortcode(context.db, input.shortcode),
  aiUsage: (context, input) => listRunAiUsageWorkflow(context.db, input),
});

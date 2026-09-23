import { runContract } from "~/contracts/run.contract";
import { executeEntity } from "~/server/entity-kernel";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getImportRunByShortcode } from "~/server/repo/import-run";
import { listRunAiUsageWorkflow } from "~/server/workflows/ai.server";

export const runHandlers = implementOperationDomain(runContract, {
  list: async (context, input) => {
    const result = await executeEntity(context, {
      action: "list",
      entity: "importRun",
      filters: input.filters,
      sort: input.sort,
      pagination: input.pagination,
      groupBy: input.groupBy,
    });
    if (result.action !== "list")
      throw new Error("Run list returned the wrong entity action");
    return { items: result.items, meta: result.meta };
  },
  detail: (context, input) =>
    getImportRunByShortcode(context.db, input.shortcode),
  aiUsage: (context, input) => listRunAiUsageWorkflow(context.db, input),
});

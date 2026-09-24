import {
  importRunPurpose,
  importRunStatus,
} from "@cubby/schemas/import-run-fields";

import { runContract } from "~/contracts/run.contract";
import { executeEntity } from "~/server/entity-kernel";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { loadImportRunByShortcode } from "~/server/purchase-import/run-service";
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
  workSnapshot: async (context, input) => {
    const run = await loadImportRunByShortcode(
      context.db,
      context.actorContext,
      input.runId,
    );
    return {
      runId: input.runId,
      purpose: importRunPurpose.parse(run.purpose),
      status: importRunStatus.parse(run.status),
      ordersSeen: run.ordersSeen,
      imported: run.imported,
      updated: run.updated,
      skipped: run.skipped,
      targetsTotal: run.targets.length,
      targetsCompleted: run.targets.filter(
        (target) => target.state === "completed" || target.state === "skipped",
      ).length,
      progress: run.progress.map((event) => ({
        phase: event.phase,
        detail: event.detail,
        createdAt: event.createdAt.toISOString(),
      })),
      operations: run.operations.map((operation) => ({
        kind: operation.kind,
        state: operation.state,
        startedAt: operation.startedAt.toISOString(),
        completedAt: operation.completedAt?.toISOString() ?? null,
        error: operation.error,
      })),
    };
  },
  aiUsage: (context, input) => listRunAiUsageWorkflow(context.db, input),
});

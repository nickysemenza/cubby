import {
  importRunPurpose,
  importRunStatus,
} from "@cubby/schemas/import-run-fields";

import { runContract } from "~/contracts/run.contract";
import { executeEntity } from "~/server/entity-kernel";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  confirmMerchantVendorRule,
  listMerchantVendorRules,
} from "~/server/purchase-import/hunts";
import {
  controlImportRun,
  loadImportRunDetail,
  loadImportRunLog,
} from "~/server/purchase-import/run-service";
import {
  listImportRuns,
  listProductImportRuns,
  resolveProductImportTarget,
  resolvePurchaseImportTarget,
} from "~/server/purchase-import/run-target";
import {
  dispatchStartedRun,
  loadTargetedImportLaunch,
  startTargetedImport,
} from "~/server/purchase-import/targeted-run";
import { getImportRunByShortcode } from "~/server/repo/import-run";
import type { AuthenticatedRequestContext } from "~/server/request-context";
import { listRunAiUsageWorkflow } from "~/server/workflows/ai.server";

/** Import runs belong to a household member's ledger party. */
async function memberParty(context: AuthenticatedRequestContext) {
  const party = await context.currentParty();
  if (!party)
    throw new Error("This login is not linked to a member ledger party yet.");
  return party;
}

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
    const run = await loadImportRunDetail(context.db, input.runId);
    return {
      runId: input.runId,
      purpose: importRunPurpose.parse(run.purpose),
      status: importRunStatus.parse(run.status),
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      coordinatorModel: run.coordinatorModel,
      agentModelMs: run.agentModelMs,
      ordersSeen: run.ordersSeen,
      imported: run.imported,
      updated: run.updated,
      skipped: run.skipped,
      targetsTotal: run.targets.length,
      targetsCompleted: run.targets.filter(
        (target) => target.state === "completed" || target.state === "skipped",
      ).length,
      progress: run.progress,
      operations: run.operations,
    };
  },
  history: async (context, input) => {
    const party = await memberParty(context);
    const purchaseId = input.purchaseId
      ? await resolvePurchaseImportTarget(context.db, input.purchaseId)
      : undefined;
    if (purchaseId === null) throw new Error("Purchase was not found");
    const productId = input.productId
      ? await resolveProductImportTarget(context.db, input.productId)
      : undefined;
    if (productId === null) throw new Error("Product was not found");
    const runs = productId
      ? await listProductImportRuns(context.db, party.id, productId)
      : await listImportRuns(context.db, party.id, purchaseId);
    return {
      runs: runs.map((run) => ({
        ...run,
        purpose: importRunPurpose.parse(run.purpose),
        startedAt: run.startedAt.toISOString(),
        endedAt: run.endedAt?.toISOString() ?? null,
      })),
    };
  },
  work: async (context, input) => {
    await memberParty(context);
    return loadImportRunDetail(context.db, input.runId);
  },
  control: async (context, { runId, ...input }) => {
    await memberParty(context);
    const control = await controlImportRun(context.db, context.actorContext, {
      runPublicId: runId,
      ...input,
    });
    if (
      "dispatchRunId" in control &&
      control.dispatchRunId &&
      control.dispatchEventId
    ) {
      await dispatchStartedRun(context.db, {
        id: control.dispatchRunId,
        eventId: control.dispatchEventId,
        purpose: control.dispatchPurpose,
        coordinatorModel: "gpt-6-sol",
      });
    }
    return {
      run: await loadImportRunDetail(context.db, runId),
      successor:
        "successorRunPublicId" in control && control.successorRunPublicId
          ? {
              publicId: control.successorRunPublicId,
              status: control.successorStatus,
              created: control.created,
            }
          : null,
    };
  },
  logs: async (context, input) => {
    await memberParty(context);
    return loadImportRunLog(context.db, input.runId);
  },
  targetedLaunch: async (context, input) =>
    loadTargetedImportLaunch(
      context.db,
      (await memberParty(context)).id,
      input.purpose,
      input.targetId,
    ),
  startTargeted: async (context, input) =>
    startTargetedImport(context.db, (await memberParty(context)).id, input),
  merchantRules: async (context) =>
    listMerchantVendorRules(context.db, (await memberParty(context)).id),
  confirmMerchantRule: async (context, input) => {
    const party = await memberParty(context);
    await confirmMerchantVendorRule(context.db, input, context.actorContext);
    return listMerchantVendorRules(context.db, party.id);
  },
  aiUsage: (context, input) => listRunAiUsageWorkflow(context.db, input),
});

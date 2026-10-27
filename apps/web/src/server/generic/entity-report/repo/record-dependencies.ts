import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { rawPurchaseOut } from "@cubby/schemas/purchase-raw-read";

import { purchaseScaffold } from "~/server/domains/purchase/repo/purchase";
import { createAppError } from "~/server/errors/app-error";
import {
  resolveOrThrow,
  resolveLiveShortcode,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

import { reportDependency } from "./dependency";

/** One live identity per entity in the request; loaders consume the parsed id. */
const recordIdentity = <E extends ShortcodeEntity>(entity: E) =>
  reportDependency(({ request: { db, id } }) => resolveOrThrow(db, entity, id));

export const runId = reportDependency(async ({ request: { db, id: code } }) => {
  const id = await resolveLiveShortcode(db, code, "run");
  if (!id) throw new Error("Import run was not found");
  return id;
});
export const reportMember = reportDependency(async ({ request }) => {
  const party = await request.viewer();
  if (!party)
    throw new Error("This login is not linked to a member ledger party yet.");
  return party;
});
export const projectId = recordIdentity("project");
export const productId = recordIdentity("product");
export const purchaseId = recordIdentity("purchase");
export const recipeId = recordIdentity("recipe");
export const locationId = recordIdentity("location");
export const cookbookId = recordIdentity("cookbook");

// Compute demand from the whole request, not whichever slot runs first.
export const purchaseFinance = reportDependency(async (execution) => {
  const { slots, db } = execution.request;
  const id = await execution.read(purchaseId);
  const reconciliation = slots.includes("purchase.reconciliation");
  const allocation = slots.includes("purchase.project-allocation");
  const settlement = slots.includes("purchase.financial-settlement");
  const projection = [
    ...(reconciliation
      ? ["statedTotal", "expenseTotal", "reconciliation"]
      : []),
    ...(allocation ? ["expenseTotal"] : []),
    ...(settlement ? ["financialReconciliation"] : []),
  ];
  const row = (await purchaseScaffold.getByIds(db, [id], projection)).data[0];
  if (!row)
    throw createAppError("PURCHASE_NOT_FOUND", `Purchase not found: ${id}`);
  return {
    reconciliation: reconciliation
      ? rawPurchaseOut
          .pick({
            id: true,
            statedTotal: true,
            expenseTotal: true,
            reconciliation: true,
          })
          .parse(row)
      : undefined,
    allocation: allocation
      ? rawPurchaseOut.pick({ id: true, expenseTotal: true }).parse(row)
      : undefined,
    settlement: settlement
      ? rawPurchaseOut
          .pick({ id: true, financialReconciliation: true })
          .parse(row)
      : undefined,
  };
});

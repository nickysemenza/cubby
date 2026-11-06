import { rawPurchaseOut } from "@cubby/schemas/purchase-raw-read";

import { purchaseScaffold } from "~/server/domains/purchase/repo/purchase";
import { createAppError } from "~/server/errors/app-error";
import { reportDependency } from "~/server/generic/entity-report/repo/dependency";
import { purchaseId } from "~/server/generic/entity-report/repo/record-dependencies";
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

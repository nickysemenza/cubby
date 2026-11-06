import { purchaseFinance } from "~/server/domains/purchase/repo/report-dependencies";
import { purchaseFinancialSettlementReport } from "~/server/domains/purchase/repo/report-purchase-financial-settlement";
import { purchaseProjectAllocationReport } from "~/server/domains/purchase/repo/report-purchase-project-allocation";
import { purchaseReconciliationReport } from "~/server/domains/purchase/repo/report-purchase-reconciliation";
import { reportDependency } from "~/server/generic/entity-report/repo/dependency";
import {
  purchaseId,
  reportMember,
} from "~/server/generic/entity-report/repo/record-dependencies";
import { recordRunsReport } from "~/server/generic/entity-report/repo/records";

export const reportBindings = {
  "purchase.runs": reportDependency(async (execution) => {
    const party = await execution.read(reportMember);
    return {
      blocks: await recordRunsReport("purchase")(
        execution.request.db,
        await execution.read(purchaseId),
        party,
      ),
    };
  }),
  "purchase.reconciliation": reportDependency(async (execution) => ({
    blocks: purchaseReconciliationReport(
      (await execution.read(purchaseFinance)).reconciliation!,
    ),
  })),
  "purchase.project-allocation": reportDependency(async (execution) => ({
    blocks: await purchaseProjectAllocationReport(
      execution.request.db,
      (await execution.read(purchaseFinance)).allocation!,
    ),
  })),
  "purchase.financial-settlement": reportDependency(async (execution) => ({
    blocks: await purchaseFinancialSettlementReport(
      execution.request.db,
      (await execution.read(purchaseFinance)).settlement!,
    ),
  })),
};

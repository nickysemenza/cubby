import { emailWorkSources } from "~/server/domains/email/repo/work-sources";
import { expenseWorkSources } from "~/server/domains/expense/repo/work-sources";
import { financialTransactionWorkSources } from "~/server/domains/financial-transaction/repo/work-sources";
import { transferWorkSource } from "~/server/domains/financial-transaction/repo/work-transfer";
import { imageWorkSources } from "~/server/domains/image/repo/work-sources";
import { ingredientWorkSources } from "~/server/domains/ingredient/repo/work-sources";
import { inventoryWorkSources } from "~/server/domains/inventory/repo/work-sources";
import { locationWorkSources } from "~/server/domains/location/repo/work-sources";
import { mealWorkSources } from "~/server/domains/meal/repo/work-sources";
import { productWorkSources } from "~/server/domains/product/repo/work-sources";
import { projectWorkContext } from "~/server/domains/project/repo/work-context";
import { projectWorkSources } from "~/server/domains/project/repo/work-sources";
import { findingWorkSources } from "~/server/domains/purchase-import/repo/work-sources";
import { plannedPurchaseWorkDeferral } from "~/server/domains/purchase/repo/work-deferral";
import { purchaseWorkSources } from "~/server/domains/purchase/repo/work-sources";
import { recipeWorkSources } from "~/server/domains/recipe/repo/work-sources";
import { runWorkSources } from "~/server/domains/run/repo/work-sources";
import { taskWorkSources } from "~/server/domains/task/repo/work-sources";
import { transactionImportWorkSources } from "~/server/domains/transaction-import/repo/work-sources";
import { vendorWorkSources } from "~/server/domains/vendor/repo/work-sources";
import { pendingSuggestionsWorkSource } from "~/server/domains/work/repo/work-suggestions";
import { diagnosticWorkSources } from "~/server/domains/work/service/work-diagnostics";
import type { WorkQueueComposition } from "~/server/generic/work-queue/repo/work-queue";

/** Explicit domains, with request-local evidence shared only by this read. */
export const workQueueComposition = async (): Promise<WorkQueueComposition> => {
  const context = projectWorkContext();
  const diagnostics = diagnosticWorkSources();
  return {
    sources: [
      ...(await productWorkSources()),
      ...(await vendorWorkSources()),
      ...purchaseWorkSources(),
      ...expenseWorkSources(),
      ...(await ingredientWorkSources()),
      ...(await recipeWorkSources()),
      ...(await inventoryWorkSources()),
      ...(await locationWorkSources()),
      ...(await mealWorkSources()),
      ...(await projectWorkSources(context)),
      ...(await taskWorkSources()),
      ...(await imageWorkSources()),
      ...financialTransactionWorkSources(),
      ...emailWorkSources,
      ...runWorkSources,
      ...findingWorkSources,
      ...transactionImportWorkSources,
      transferWorkSource,
      pendingSuggestionsWorkSource,
      ...diagnostics.sources,
    ],
    deferrals: [plannedPurchaseWorkDeferral()],
    incompleteProjectIds: context.incompleteProjectIds,
    incompleteDiagnosticSources: diagnostics.incompleteDiagnosticSources,
  };
};

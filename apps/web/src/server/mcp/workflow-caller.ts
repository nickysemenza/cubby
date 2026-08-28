import { ingredientRecipeUsagesOut } from "@cubby/schemas/ingredient";
import { mealRecipeIdInput, mealUpdateRecipeInput } from "@cubby/schemas/meal";
import {
  type patchProductExternalIdsInput,
  type productExternalIdCollisionInput,
  productExternalIdCollisionsOut,
  type productFindOrCreateByUPCInput,
} from "@cubby/schemas/product";
import type { z } from "zod";

import {
  clearDataException,
  findProductExternalIdCollisions,
  setDataException,
} from "~/server/repo/data-quality";
import { previewFinancialStatementImport } from "~/server/repo/financial-statement-preview";
import { patchProductExternalIds } from "~/server/repo/product";
import { reclassifyPurchaseDocument } from "~/server/repo/purchase";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import { verifyProductImages } from "~/server/services/image-verification.service";
import { lookupUPC } from "~/server/services/product-orchestration.service";
import { getProductWithFood } from "~/server/services/product.service";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import { listAuditLog } from "~/server/workflows/audit-log";
import { previewOperation } from "~/server/workflows/entity-integrity-preview.server";
import {
  expenseAnalyticsWorkflow,
  expenseMatchWorkflow,
} from "~/server/workflows/expense.server";
import {
  householdContributionLedgerWorkflow,
  projectContributionWorkflow,
  suggestFinancialTransferPairsWorkflow,
} from "~/server/workflows/household-contribution.server";
import {
  attachFileWorkflow,
  createFileUploadWorkflow,
} from "~/server/workflows/image.server";
import {
  recipeUsagesWorkflow,
  resolveOrCreateWorkflow,
} from "~/server/workflows/ingredient.server";
import { moveInventoryEntriesWorkflow } from "~/server/workflows/inventory.server";
import {
  addRecipeToMealWorkflow,
  getShoppingListWorkflow,
  removeMealRecipeWorkflow,
  updateMealRecipeWorkflow,
} from "~/server/workflows/meal.server";
import {
  findCoverageProblemsWorkflow,
  findFastProblemsWorkflow,
  findProblemByTypeWorkflow,
  findProblemCountsWorkflow,
  findTrackerProblemsWorkflow,
  findUpcProblemsWorkflow,
  findViewProblemsWorkflow,
} from "~/server/workflows/problems.server";
import {
  findOrCreateProductByUpcWorkflow,
  listProductComponentsWorkflow,
  listProductProjectUsesWorkflow,
} from "~/server/workflows/product.server";
import {
  projectDashboardSummaryWorkflow,
  projectPortfolioAnalyticsWorkflow,
  projectRepointUsesWorkflow,
  projectResourcesWorkflow,
  projectToolSuggestionsWorkflow,
} from "~/server/workflows/project.server";
import {
  linkExpensesToPurchaseWorkflow,
  purchaseProductsWorkflow,
  splitExpenseWorkflow,
} from "~/server/workflows/purchase.server";
import {
  insertImportWorkflow,
  scrapeWorkflow,
} from "~/server/workflows/recipe-import.server";
import {
  explainCostingWorkflow,
  getAllTagsWorkflow,
  getMakeableWorkflow,
} from "~/server/workflows/recipe.server";
import {
  findRelatedSearchHitsWorkflow,
  findSearchHitsWorkflow,
  findSimilarEntitiesWorkflow,
} from "~/server/workflows/search.server";
import {
  deleteStatementRowsWorkflow,
  findStatementRowDriftWorkflow,
  getStatementRowSummaryWorkflow,
  listStatementImportsWorkflow,
  listStatementRowsWorkflow,
  recordStatementRowsWorkflow,
  updateStatementRowsWorkflow,
} from "~/server/workflows/statement-row.server";
import {
  taskListActionableWorkflow,
  taskSummaryWorkflow,
} from "~/server/workflows/task.server";
import { findUsdaFoodWorkflow } from "~/server/workflows/usda.server";

const productShortcodes = bindShortcodeResolver("product");

/**
 * In-process workflow surface shared by external MCP requests and the in-app
 * agent. It deliberately contains no transport, router, or procedure objects:
 * MCP tool validation happens at registration and each method enters the same
 * workflow/repository function used by the browser Start adapter.
 */
export const createMcpWorkflowCaller = (
  context: AuthenticatedStartOperationContext,
) => ({
  auditLog: {
    list: (input: Parameters<typeof listAuditLog>[0]["data"]) =>
      listAuditLog({ db: context.readDb, data: input }),
  },
  dataQuality: {
    setException: (input: Parameters<typeof setDataException>[1]) =>
      setDataException(context.db, input, context.actorContext),
    clearException: (input: Parameters<typeof clearDataException>[1]) =>
      clearDataException(context.db, input, context.actorContext),
  },
  entityIntegrity: {
    previewOperation: (input: Parameters<typeof previewOperation>[1]) =>
      previewOperation(context.readDb, input, new Date()),
  },
  expense: {
    analytics: (input: Parameters<typeof expenseAnalyticsWorkflow>[1]) =>
      expenseAnalyticsWorkflow(context.readDb, input),
    match: (input: Parameters<typeof expenseMatchWorkflow>[1]) =>
      expenseMatchWorkflow(context.readDb, input),
  },
  financialTransaction: {
    previewStatementImport: (
      input: Parameters<typeof previewFinancialStatementImport>[1],
    ) => previewFinancialStatementImport(context.readDb, input),
  },
  householdContribution: {
    ledger: (
      input: Parameters<typeof householdContributionLedgerWorkflow>[1],
    ) => householdContributionLedgerWorkflow(context.readDb, input),
    project: (input: Parameters<typeof projectContributionWorkflow>[1]) =>
      projectContributionWorkflow(context.readDb, input),
    suggestTransferPairs: (
      input: Parameters<typeof suggestFinancialTransferPairsWorkflow>[1],
    ) => suggestFinancialTransferPairsWorkflow(context.readDb, input),
  },
  image: {
    attachFile: (input: Parameters<typeof attachFileWorkflow>[1]) =>
      attachFileWorkflow(context.db, input),
    createFileUpload: (input: Parameters<typeof createFileUploadWorkflow>[1]) =>
      createFileUploadWorkflow(context.db, input),
  },
  ingredient: {
    recipeUsages: async (input: Parameters<typeof recipeUsagesWorkflow>[1]) =>
      ingredientRecipeUsagesOut.parse(
        await recipeUsagesWorkflow(context.readDb, input),
      ),
    resolveOrCreate: (input: Parameters<typeof resolveOrCreateWorkflow>[1]) =>
      resolveOrCreateWorkflow(context.db, input),
  },
  inventory: {
    moveEntries: (input: Parameters<typeof moveInventoryEntriesWorkflow>[2]) =>
      moveInventoryEntriesWorkflow(context.db, context.actorContext, input),
  },
  meal: {
    addRecipe: (input: Parameters<typeof addRecipeToMealWorkflow>[1]) =>
      addRecipeToMealWorkflow(context.db, input, context.actorContext),
    updateRecipe: (input: z.input<typeof mealUpdateRecipeInput>) =>
      updateMealRecipeWorkflow(
        context.db,
        mealUpdateRecipeInput.parse(input),
        context.actorContext,
      ),
    removeRecipe: (input: z.input<typeof mealRecipeIdInput>) =>
      removeMealRecipeWorkflow(
        context.db,
        mealRecipeIdInput.parse(input),
        context.actorContext,
      ),
    getShoppingList: (input: Parameters<typeof getShoppingListWorkflow>[1]) =>
      getShoppingListWorkflow(
        context.readDb,
        input,
        context.services.availability,
      ),
  },
  problems: {
    getFast: () => findFastProblemsWorkflow(context),
    getCounts: () => findProblemCountsWorkflow(context),
    getByType: (input: Parameters<typeof findProblemByTypeWorkflow>[1]) =>
      findProblemByTypeWorkflow(context, input),
    getViews: () => findViewProblemsWorkflow(context),
    getCoverage: () => findCoverageProblemsWorkflow(context),
    getUpc: () => findUpcProblemsWorkflow(context),
    getTracker: () => findTrackerProblemsWorkflow(context),
  },
  product: {
    externalIdCollisions: (
      input: z.output<typeof productExternalIdCollisionInput>,
    ) =>
      findProductExternalIdCollisions(context.readDb, input).then((result) =>
        productExternalIdCollisionsOut.parse(result),
      ),
    patchExternalIds: async (
      input: z.output<typeof patchProductExternalIdsInput>,
    ) => {
      const id = await productShortcodes.one(context.db, input.id);
      await patchProductExternalIds(
        context.db,
        id,
        input,
        context.actorContext,
      );
      return getProductWithFood(context.db, context.usdaClient, id);
    },
    verifyImages: async (
      input: Parameters<typeof productShortcodes.one>[1],
    ) => {
      const id = await productShortcodes.one(context.db, input);
      await verifyProductImages(context.db, id);
      return getProductWithFood(context.db, context.usdaClient, id);
    },
    lookupUpc: (
      input: Pick<z.output<typeof productFindOrCreateByUPCInput>, "upc">,
    ) =>
      lookupUPC(
        context.readDb,
        context.usdaClient,
        context.upcLookupClient,
        input.upc,
      ),
    findOrCreateByUPC: (
      input: Parameters<typeof findOrCreateProductByUpcWorkflow>[1],
    ) => findOrCreateProductByUpcWorkflow(context, input),
    projectUses: (
      input: Parameters<typeof listProductProjectUsesWorkflow>[1],
    ) => listProductProjectUsesWorkflow(context, input),
    components: (input: Parameters<typeof listProductComponentsWorkflow>[1]) =>
      listProductComponentsWorkflow(context, input),
  },
  project: {
    resources: (input: Parameters<typeof projectResourcesWorkflow>[1]) =>
      projectResourcesWorkflow(context.readDb, input),
    toolSuggestions: (
      input: Parameters<typeof projectToolSuggestionsWorkflow>[1],
    ) => projectToolSuggestionsWorkflow(context.readDb, input),
    repointUses: (input: Parameters<typeof projectRepointUsesWorkflow>[1]) =>
      projectRepointUsesWorkflow(context.db, input, context.actorContext),
    dashboardSummary: (
      input: Parameters<typeof projectDashboardSummaryWorkflow>[1],
    ) => projectDashboardSummaryWorkflow(context.readDb, input),
    portfolioAnalytics: (
      input: Parameters<typeof projectPortfolioAnalyticsWorkflow>[1],
    ) => projectPortfolioAnalyticsWorkflow(context.readDb, input),
  },
  purchase: {
    link: (input: Parameters<typeof linkExpensesToPurchaseWorkflow>[1]) =>
      linkExpensesToPurchaseWorkflow(context, input),
    split: (input: Parameters<typeof splitExpenseWorkflow>[1]) =>
      splitExpenseWorkflow(context, input),
    products: (input: Parameters<typeof purchaseProductsWorkflow>[1]) =>
      purchaseProductsWorkflow(context, input),
    reclassifyDocument: (
      input: Parameters<typeof reclassifyPurchaseDocument>[1],
    ) => reclassifyPurchaseDocument(context.db, input, context.actorContext),
  },
  recipe: {
    scrape: (input: Parameters<typeof scrapeWorkflow>[0]) =>
      scrapeWorkflow(input),
    insertImport: (input: Parameters<typeof insertImportWorkflow>[1]) =>
      insertImportWorkflow(context, input),
    getAllTags: () => getAllTagsWorkflow(context.readDb),
    explainCosting: (input: Parameters<typeof explainCostingWorkflow>[1]) =>
      explainCostingWorkflow(
        context.readDb,
        input,
        context.services.recipeCosting,
      ),
  },
  search: {
    find: (input: Parameters<typeof findSearchHitsWorkflow>[1]) =>
      findSearchHitsWorkflow(context.readDb, input),
    related: (input: Parameters<typeof findRelatedSearchHitsWorkflow>[1]) =>
      findRelatedSearchHitsWorkflow(context.readDb, input),
    similar: (input: Parameters<typeof findSimilarEntitiesWorkflow>[1]) =>
      findSimilarEntitiesWorkflow(context.readDb, input),
  },
  statementRow: {
    list: (input: Parameters<typeof listStatementRowsWorkflow>[1]) =>
      listStatementRowsWorkflow(context.readDb, input),
    summary: (input: Parameters<typeof getStatementRowSummaryWorkflow>[1]) =>
      getStatementRowSummaryWorkflow(context.readDb, input),
    imports: (input: Parameters<typeof listStatementImportsWorkflow>[1]) =>
      listStatementImportsWorkflow(context.readDb, input),
    drift: (input: Parameters<typeof findStatementRowDriftWorkflow>[1]) =>
      findStatementRowDriftWorkflow(context.readDb, input),
    record: (input: Parameters<typeof recordStatementRowsWorkflow>[2]) =>
      recordStatementRowsWorkflow(context.db, context.actorContext, input),
    update: (input: Parameters<typeof updateStatementRowsWorkflow>[2]) =>
      updateStatementRowsWorkflow(context.db, context.actorContext, input),
    delete: (input: Parameters<typeof deleteStatementRowsWorkflow>[2]) =>
      deleteStatementRowsWorkflow(context.db, context.actorContext, input),
  },
  suggestions: {
    getMakeable: (input: Parameters<typeof getMakeableWorkflow>[1]) =>
      getMakeableWorkflow(context.readDb, input, context.services.availability),
  },
  task: {
    listActionable: () => taskListActionableWorkflow(context.readDb, undefined),
    summary: () => taskSummaryWorkflow(context.readDb),
  },
  usda: {
    getByAlternateID: (input: Parameters<typeof findUsdaFoodWorkflow>[1]) =>
      findUsdaFoodWorkflow(context.usdaService, input),
  },
});

export type McpWorkflowCaller = ReturnType<typeof createMcpWorkflowCaller>;

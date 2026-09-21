import type {
  imageDescriptionCorrectionInput,
  imageProcessingStatusInput,
  scheduleImageProcessingInput,
} from "@cubby/schemas/image-processing";
import {
  type patchProductExternalIdsInput,
  type productExternalIdCollisionInput,
  productExternalIdCollisionsOut,
  type productFindOrCreateByUPCInput,
  type productResolveNamesInput,
} from "@cubby/schemas/product";
import type { z } from "zod";

import {
  clearDataException,
  findProductExternalIdCollisions,
  setDataException,
} from "~/server/repo/data-quality";
import { previewFinancialStatementImport } from "~/server/repo/financial-statement-preview";
import {
  getImageProcessingReadProjection,
  saveImageDescriptionCorrection,
} from "~/server/repo/image-processing";
import { patchProductExternalIds } from "~/server/repo/product";
import { reclassifyPurchaseDocument } from "~/server/repo/purchase";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { scheduleImageProcessingJobs } from "~/server/services/image-processing.service";
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
  attachExistingImageWorkflow,
  createFileUploadWorkflow,
} from "~/server/workflows/image.server";
import {
  recipeUsagesWorkflow,
  resolveOrCreateWorkflow,
} from "~/server/workflows/ingredient.server";
import { moveInventoryEntriesWorkflow } from "~/server/workflows/inventory.server";
import {
  addRecipeToMealWorkflow,
  getMealPreparationsWorkflow,
  getMealNutritionWorkflow,
  getShoppingListWorkflow,
  removeMealRecipeWorkflow,
  saveMealRecipePreparationWorkflow,
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
  resolveProductNamesWorkflow,
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

type CallerContext = AuthenticatedStartOperationContext;

/**
 * Every workflow method as `(context) => handler`, grouped by domain. This
 * table is the single declaration: `createMcpWorkflowCaller` binds it to a
 * request context, and `callerMethodRoster` (the runtime shape check
 * `caller-contract.ts` applies at the SDK boundary) is derived from its keys,
 * so adding a method here is the whole change.
 */
const callerDomains = {
  auditLog: {
    list:
      (context: CallerContext) =>
      (input: Parameters<typeof listAuditLog>[0]["data"]) =>
        listAuditLog({ db: context.readDb, data: input }),
  },
  dataQuality: {
    setException:
      (context: CallerContext) =>
      (input: Parameters<typeof setDataException>[1]) =>
        setDataException(context.db, input, context.actorContext),
    clearException:
      (context: CallerContext) =>
      (input: Parameters<typeof clearDataException>[1]) =>
        clearDataException(context.db, input, context.actorContext),
  },
  entityIntegrity: {
    previewOperation:
      (context: CallerContext) =>
      (input: Parameters<typeof previewOperation>[1]) =>
        previewOperation(context.readDb, input, new Date()),
  },
  expense: {
    analytics:
      (context: CallerContext) =>
      (input: Parameters<typeof expenseAnalyticsWorkflow>[1]) =>
        expenseAnalyticsWorkflow(context.readDb, input),
    match:
      (context: CallerContext) =>
      (input: Parameters<typeof expenseMatchWorkflow>[1]) =>
        expenseMatchWorkflow(context.readDb, input),
  },
  financialTransaction: {
    previewStatementImport:
      (context: CallerContext) =>
      (input: Parameters<typeof previewFinancialStatementImport>[1]) =>
        previewFinancialStatementImport(context.readDb, input),
  },
  householdContribution: {
    ledger:
      (context: CallerContext) =>
      (input: Parameters<typeof householdContributionLedgerWorkflow>[1]) =>
        householdContributionLedgerWorkflow(context.readDb, input),
    project:
      (context: CallerContext) =>
      (input: Parameters<typeof projectContributionWorkflow>[1]) =>
        projectContributionWorkflow(context.readDb, input),
    suggestTransferPairs:
      (context: CallerContext) =>
      (input: Parameters<typeof suggestFinancialTransferPairsWorkflow>[1]) =>
        suggestFinancialTransferPairsWorkflow(context.readDb, input),
  },
  image: {
    attachFile:
      (context: CallerContext) =>
      (input: Parameters<typeof attachFileWorkflow>[1]) =>
        attachFileWorkflow(context.db, input),
    attachExisting:
      (context: CallerContext) =>
      (input: Parameters<typeof attachExistingImageWorkflow>[2]) =>
        attachExistingImageWorkflow(context.db, context.actorContext, input),
    createFileUpload:
      (context: CallerContext) =>
      (input: Parameters<typeof createFileUploadWorkflow>[1]) =>
        createFileUploadWorkflow(context.db, input),
  },
  imageProcessing: {
    schedule:
      (context: CallerContext) =>
      (input: z.output<typeof scheduleImageProcessingInput>) =>
        scheduleImageProcessingJobs(context.db, input),
    get:
      (context: CallerContext) =>
      async (input: z.output<typeof imageProcessingStatusInput>) =>
        getImageProcessingReadProjection(
          context.readDb,
          await resolveOrThrow(context.readDb, "image", input.id),
        ),
    correctDescription:
      (context: CallerContext) =>
      async (input: z.output<typeof imageDescriptionCorrectionInput>) => {
        await saveImageDescriptionCorrection(context.db, {
          imageId: await resolveOrThrow(context.db, "image", input.id),
          description: input.description,
        });
        return { saved: true as const };
      },
  },
  ingredient: {
    recipeUsages:
      (context: CallerContext) =>
      async (input: Parameters<typeof recipeUsagesWorkflow>[1]) =>
        await recipeUsagesWorkflow(context.readDb, input),
    resolveOrCreate:
      (context: CallerContext) =>
      (input: Parameters<typeof resolveOrCreateWorkflow>[1]) =>
        resolveOrCreateWorkflow(context.db, input),
  },
  inventory: {
    moveEntries:
      (context: CallerContext) =>
      (input: Parameters<typeof moveInventoryEntriesWorkflow>[2]) =>
        moveInventoryEntriesWorkflow(context.db, context.actorContext, input),
  },
  meal: {
    getNutrition:
      (context: CallerContext) =>
      (input: Parameters<typeof getMealNutritionWorkflow>[1]) =>
        getMealNutritionWorkflow(
          context.readDb,
          input,
          context.usdaClient,
          context.services.recipeCosting,
        ),
    getPreparations:
      (context: CallerContext) =>
      (input: Parameters<typeof getMealPreparationsWorkflow>[1]) =>
        getMealPreparationsWorkflow(
          context.readDb,
          input,
          context.services.recipeCosting,
        ),
    addRecipe:
      (context: CallerContext) =>
      (input: Parameters<typeof addRecipeToMealWorkflow>[1]) =>
        addRecipeToMealWorkflow(context.db, input, context.actorContext),
    updateRecipe:
      (context: CallerContext) =>
      (input: Parameters<typeof updateMealRecipeWorkflow>[1]) =>
        updateMealRecipeWorkflow(context.db, input, context.actorContext),
    removeRecipe:
      (context: CallerContext) =>
      (input: Parameters<typeof removeMealRecipeWorkflow>[1]) =>
        removeMealRecipeWorkflow(context.db, input, context.actorContext),
    savePreparation:
      (context: CallerContext) =>
      (input: Parameters<typeof saveMealRecipePreparationWorkflow>[1]) =>
        saveMealRecipePreparationWorkflow(
          context.db,
          input,
          context.actorContext,
        ),
    getShoppingList:
      (context: CallerContext) =>
      (input: Parameters<typeof getShoppingListWorkflow>[1]) =>
        getShoppingListWorkflow(
          context.readDb,
          input,
          context.services.availability,
        ),
  },
  problems: {
    getFast: (context: CallerContext) => () =>
      findFastProblemsWorkflow(context),
    getCounts: (context: CallerContext) => () =>
      findProblemCountsWorkflow(context),
    getByType:
      (context: CallerContext) =>
      (input: Parameters<typeof findProblemByTypeWorkflow>[1]) =>
        findProblemByTypeWorkflow(context, input),
    getViews: (context: CallerContext) => () =>
      findViewProblemsWorkflow(context),
    getCoverage: (context: CallerContext) => () =>
      findCoverageProblemsWorkflow(context),
    getUpc: (context: CallerContext) => () => findUpcProblemsWorkflow(context),
    getTracker: (context: CallerContext) => () =>
      findTrackerProblemsWorkflow(context),
  },
  product: {
    resolveNames:
      (context: CallerContext) =>
      (input: z.output<typeof productResolveNamesInput>) =>
        resolveProductNamesWorkflow(context, input),
    externalIdCollisions:
      (context: CallerContext) =>
      (input: z.output<typeof productExternalIdCollisionInput>) =>
        findProductExternalIdCollisions(context.readDb, input).then((result) =>
          productExternalIdCollisionsOut.parse(result),
        ),
    patchExternalIds:
      (context: CallerContext) =>
      async (input: z.output<typeof patchProductExternalIdsInput>) => {
        const id = await productShortcodes.one(context.db, input.id);
        await patchProductExternalIds(
          context.db,
          id,
          input,
          context.actorContext,
        );
        return getProductWithFood(context.db, context.usdaClient, id);
      },
    verifyImages:
      (context: CallerContext) =>
      async (input: Parameters<typeof productShortcodes.one>[1]) => {
        const id = await productShortcodes.one(context.db, input);
        await verifyProductImages(context.db, id);
        return getProductWithFood(context.db, context.usdaClient, id);
      },
    lookupUpc:
      (context: CallerContext) =>
      (input: Pick<z.output<typeof productFindOrCreateByUPCInput>, "upc">) =>
        lookupUPC(
          context.readDb,
          context.usdaClient,
          context.upcLookupClient,
          input.upc,
        ),
    findOrCreateByUPC:
      (context: CallerContext) =>
      (input: Parameters<typeof findOrCreateProductByUpcWorkflow>[1]) =>
        findOrCreateProductByUpcWorkflow(context, input),
    projectUses:
      (context: CallerContext) =>
      (input: Parameters<typeof listProductProjectUsesWorkflow>[1]) =>
        listProductProjectUsesWorkflow(context, input),
    components:
      (context: CallerContext) =>
      (input: Parameters<typeof listProductComponentsWorkflow>[1]) =>
        listProductComponentsWorkflow(context, input),
  },
  project: {
    resources:
      (context: CallerContext) =>
      (input: Parameters<typeof projectResourcesWorkflow>[1]) =>
        projectResourcesWorkflow(context.readDb, input),
    toolSuggestions:
      (context: CallerContext) =>
      (input: Parameters<typeof projectToolSuggestionsWorkflow>[1]) =>
        projectToolSuggestionsWorkflow(context.readDb, input),
    repointUses:
      (context: CallerContext) =>
      (input: Parameters<typeof projectRepointUsesWorkflow>[1]) =>
        projectRepointUsesWorkflow(context.db, input, context.actorContext),
    dashboardSummary:
      (context: CallerContext) =>
      (input: Parameters<typeof projectDashboardSummaryWorkflow>[1]) =>
        projectDashboardSummaryWorkflow(context.readDb, input),
    portfolioAnalytics:
      (context: CallerContext) =>
      (input: Parameters<typeof projectPortfolioAnalyticsWorkflow>[1]) =>
        projectPortfolioAnalyticsWorkflow(context.readDb, input),
  },
  purchase: {
    link:
      (context: CallerContext) =>
      (input: Parameters<typeof linkExpensesToPurchaseWorkflow>[1]) =>
        linkExpensesToPurchaseWorkflow(context, input),
    split:
      (context: CallerContext) =>
      (input: Parameters<typeof splitExpenseWorkflow>[1]) =>
        splitExpenseWorkflow(context, input),
    products:
      (context: CallerContext) =>
      (input: Parameters<typeof purchaseProductsWorkflow>[1]) =>
        purchaseProductsWorkflow(context, input),
    reclassifyDocument:
      (context: CallerContext) =>
      (input: Parameters<typeof reclassifyPurchaseDocument>[1]) =>
        reclassifyPurchaseDocument(context.db, input, context.actorContext),
  },
  recipe: {
    scrape: () => (input: Parameters<typeof scrapeWorkflow>[0]) =>
      scrapeWorkflow(input),
    insertImport:
      (context: CallerContext) =>
      (input: Parameters<typeof insertImportWorkflow>[1]) =>
        insertImportWorkflow(context, input),
    getAllTags: (context: CallerContext) => () =>
      getAllTagsWorkflow(context.readDb),
    explainCosting:
      (context: CallerContext) =>
      (input: Parameters<typeof explainCostingWorkflow>[1]) =>
        explainCostingWorkflow(
          context.readDb,
          input,
          context.services.recipeCosting,
        ),
  },
  search: {
    find:
      (context: CallerContext) =>
      (input: Parameters<typeof findSearchHitsWorkflow>[1]) =>
        findSearchHitsWorkflow(context.readDb, input),
    related:
      (context: CallerContext) =>
      (input: Parameters<typeof findRelatedSearchHitsWorkflow>[1]) =>
        findRelatedSearchHitsWorkflow(context.readDb, input),
    similar:
      (context: CallerContext) =>
      (input: Parameters<typeof findSimilarEntitiesWorkflow>[1]) =>
        findSimilarEntitiesWorkflow(context.readDb, input),
  },
  statementRow: {
    list:
      (context: CallerContext) =>
      (input: Parameters<typeof listStatementRowsWorkflow>[1]) =>
        listStatementRowsWorkflow(context.readDb, input),
    summary:
      (context: CallerContext) =>
      (input: Parameters<typeof getStatementRowSummaryWorkflow>[1]) =>
        getStatementRowSummaryWorkflow(context.readDb, input),
    imports:
      (context: CallerContext) =>
      (input: Parameters<typeof listStatementImportsWorkflow>[1]) =>
        listStatementImportsWorkflow(context.readDb, input),
    drift:
      (context: CallerContext) =>
      (input: Parameters<typeof findStatementRowDriftWorkflow>[1]) =>
        findStatementRowDriftWorkflow(context.readDb, input),
    record:
      (context: CallerContext) =>
      (input: Parameters<typeof recordStatementRowsWorkflow>[2]) =>
        recordStatementRowsWorkflow(context.db, context.actorContext, input),
    update:
      (context: CallerContext) =>
      (input: Parameters<typeof updateStatementRowsWorkflow>[2]) =>
        updateStatementRowsWorkflow(context.db, context.actorContext, input),
    delete:
      (context: CallerContext) =>
      (input: Parameters<typeof deleteStatementRowsWorkflow>[2]) =>
        deleteStatementRowsWorkflow(context.db, context.actorContext, input),
  },
  suggestions: {
    getMakeable:
      (context: CallerContext) =>
      (input: Parameters<typeof getMakeableWorkflow>[1]) =>
        getMakeableWorkflow(
          context.readDb,
          input,
          context.services.availability,
        ),
  },
  task: {
    listActionable: (context: CallerContext) => () =>
      taskListActionableWorkflow(context.readDb, undefined),
    summary: (context: CallerContext) => () =>
      taskSummaryWorkflow(context.readDb),
  },
  usda: {
    getByAlternateID:
      (context: CallerContext) =>
      (input: Parameters<typeof findUsdaFoodWorkflow>[1]) =>
        findUsdaFoodWorkflow(context.usdaService, input),
  },
};

type CallerDomains = typeof callerDomains;
type BoundCaller = {
  [Domain in keyof CallerDomains]: {
    [
      Method in keyof CallerDomains[Domain]
    ]: CallerDomains[Domain][Method] extends (
      context: CallerContext,
    ) => infer Handler
      ? Handler
      : never;
  };
};

const bindDomains = (context: CallerContext): BoundCaller =>
  // SAFETY: same domain and method keys as `callerDomains`, each value the
  // handler its factory returns for `context`; `fromEntries` erases the
  // per-key correlation the mapped type restores.
  Object.fromEntries(
    Object.entries(callerDomains).map(([domain, methods]) => [
      domain,
      Object.fromEntries(
        Object.entries(methods).map(([method, factory]) => [
          method,
          factory(context),
        ]),
      ),
    ]),
  ) as BoundCaller;

/**
 * In-process workflow surface shared by external MCP requests and the in-app
 * agent. It deliberately contains no transport, router, or procedure objects:
 * MCP tool validation happens at registration and each method enters the same
 * workflow/repository function used by the browser Start adapter.
 */
export const createMcpWorkflowCaller = (context: CallerContext): BoundCaller =>
  bindDomains(context);

/** Domain → method → `true`, from the same table; the shape `caller-contract.ts` checks. */
type CallerMethodRoster = {
  [Domain in keyof CallerDomains]: {
    [Method in keyof CallerDomains[Domain]]: true;
  };
};
export const callerMethodRoster =
  // SAFETY: keys mirror `callerDomains` one-for-one; values are the literal `true`.
  Object.fromEntries(
    Object.entries(callerDomains).map(([domain, methods]) => [
      domain,
      Object.fromEntries(Object.keys(methods).map((method) => [method, true])),
    ]),
  ) as CallerMethodRoster;

export type McpWorkflowCaller = BoundCaller;

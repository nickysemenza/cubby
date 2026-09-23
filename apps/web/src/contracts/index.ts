export { activityContract } from "./activity.contract";
/**
 * Every operation contract, by export name. The registry generator imports
 * this barrel at build time; the HTTP router imports it at runtime. A contract
 * module that is not exported here is a generator error.
 */
export { aiContract, aiStreamsContract } from "./ai.contract";
export { auditLogContract } from "./audit-log.contract";
export { calendarContract } from "./calendar.contract";
export { collectionContract } from "./collection.contract";
export { oauthContract } from "./connected-apps.contract";
export { cookbookContract } from "./cookbook.contract";
export { dashboardContract } from "./dashboard.contract";
export { entityDetailContract } from "./entity-detail.contract";
export { entityFilterOptionsContract } from "./entity-filter-options.contract";
export { entityGraphContract } from "./entity-graph.contract";
export { entityInspectorHealthContract } from "./entity-inspector-health.contract";
export {
  entityIntegrityContract,
  integrityProblemsContract,
} from "./entity-integrity.contract";
export { entityListContract } from "./entity-list.contract";
export { entityMediaContract } from "./entity-media.contract";
export { entityMutationContract } from "./entity-mutation.contract";
export { entityTimelineContract } from "./entity-timeline.contract";
export { expenseContract } from "./expense.contract";
export {
  financialAccountContract,
  ledgerPartyContract,
  financialTransactionContract,
} from "./finance.contract";
export { householdContributionContract } from "./household-contribution.contract";
export { imageUploadContract } from "./image-upload.contract";
export { imageContract } from "./image.contract";
export { imageProcessingContract } from "./image-processing.contract";
export { ingredientContract } from "./ingredient.contract";
export { inventoryContract } from "./inventory.contract";
export { locationContract } from "./location.contract";
export { maintenanceContract } from "./maintenance.contract";
export { mcpContract } from "./mcp.contract";
export { mealContract } from "./meal.contract";
export { problemsContract, problemsStreamsContract } from "./problems.contract";
export { photoImportContract } from "./photo-import.contract";
export { productContract, productStreamsContract } from "./product.contract";
export { projectContract } from "./project.contract";
export { purchaseContract } from "./purchase.contract";
export { purchaseImportContract } from "./purchase-import.contract";
export {
  recipeContract,
  suggestionsContract,
  recipeStreamsContract,
} from "./recipe.contract";
export {
  relatednessContract,
  recommendationsContract,
} from "./recommendations.contract";
export { relatedDataContract } from "./related-data.contract";
export { runContract } from "./run.contract";
export { searchContract, searchStreamsContract } from "./search.contract";
export { statementRowContract } from "./statement-row.contract";
export { taskContract } from "./task.contract";
export { upcContract } from "./upc.contract";
export { usdaFoodContract } from "./usda.contract";
export { vendorContract } from "./vendor.contract";

export { fieldExplanationContract } from "./field-explanation.contract";

/** Native convenience names for operations that need no handwritten mapping. */
export const CLIENT_PASSTHROUGH_METHODS = {
  "chatgpt.authorizationHost": {
    method: "chatGptAuthorizationHost",
    doc: null,
  },
  "chatgpt.connect": { method: "connectChatGpt", doc: null },
  "purchase.settlementCandidates": {
    method: "purchaseSettlementCandidates",
    doc: "Unallocated statement entries near an order, already ranked and worded. Advisory: reading allocates nothing.",
  },
  "purchase.suggestSettlementMatch": {
    method: "suggestPurchaseSettlementMatch",
    doc: "An advisory ordering of equally ranked candidates. It never selects or allocates; the person still chooses and saves.",
  },
  "purchase.checkSettlementAllocation": {
    method: "checkPurchaseSettlementAllocation",
    doc: "Whether typed allocation rows can be saved against a statement entry, and why not. The only allocation rule clients consult.",
  },
  "purchase.splitStart": {
    method: "startExpenseSplit",
    doc: "The starting parts of a split, its wording and the sentence to confirm before it replaces the expense.",
  },
  "purchase.checkSplit": {
    method: "checkExpenseSplit",
    doc: "Whether typed split parts can be saved, and the exact body to send when they can. The only split rule clients consult.",
  },
  "purchase.split": {
    method: "splitExpense",
    doc: "Replaces one expense with its parts. Send the body `checkExpenseSplit` returned, after the person confirmed.",
  },
  "purchase.link": {
    method: "attachExpensesToPurchase",
    doc: "Moves the selected expenses onto a Purchase. Send the ids `checkPurchaseExpenseLink` returned.",
  },
  "purchase.linkExpenseCandidates": {
    method: "purchaseLinkExpenseCandidates",
    doc: "Expenses that can be attached to a Purchase for a scope and search, already worded.",
  },
  "purchase.checkLinkExpenses": {
    method: "checkPurchaseExpenseLink",
    doc: "Whether an expense selection can be attached to a Purchase, what it does to the expense total, and what to confirm.",
  },
  "purchase.linkProductCandidates": {
    method: "purchaseLinkProductCandidates",
    doc: "Products that can be attached to a Purchase: a search minus what is already attached.",
  },
  "purchase.attachProducts": {
    method: "attachProductsToPurchase",
    doc: "Records which products a Purchase bought. The link carries no money or quantity.",
  },
  "recipe.getIngredientUsage": { method: "ingredientUsage", doc: null },
  "meal.addRecipe": {
    method: "addRecipeToMeal",
    doc: "Plans a recipe into a meal at a scale; the composition report's Add recipe command sends it.",
  },
  "meal.updateRecipe": {
    method: "updateMealRecipe",
    doc: "Changes the scale of one recipe in a meal.",
  },
  "meal.removeRecipe": {
    method: "removeMealRecipe",
    doc: "Removes one recipe from a meal, after the report's confirmation.",
  },
  "meal.savePreparation": {
    method: "saveMealPreparation",
    doc: "Sets or removes a prepared recipe's portions and records its yield.",
  },
  "recipe.reprocessCookbookOnce": {
    method: "reprocessCookbook",
    doc: "Re-derives a cookbook's imported recipes from its stored extraction (no AI) and answers once with the summary.",
  },
  "recipe.importCookbookRecipesOnce": {
    method: "importCookbookRecipes",
    doc: "Imports the named source recipes from a cookbook's stored extraction and answers once with the summary.",
  },
  "recipe.generateFlow": {
    method: "generateRecipeFlow",
    doc: "Asks the AI to arrange a recipe's steps into a walkthrough; the report slot offers it behind a confirmation.",
  },
  "recipe.reparseLine": {
    method: "reparseRecipeLine",
    doc: "Re-parses one stored recipe line with the current parser; the server decides what changes and writes only that.",
  },
  // The collection-section actions' operations (`nativeCollectionActionPlans`), decoded from the
  // runner's form values into these typed inputs.
  "ai.describeLocation": { method: "describeLocation", doc: null },
  "assessment.review": { method: "reviewAssessment", doc: null },
  "assessment.reviewBatch": { method: "reviewAssessments", doc: null },
  "connection.read": { method: "readConnections", doc: null },
  "connection.discover": { method: "discoverConnections", doc: null },
  "image.attachExisting": { method: "attachExistingImage", doc: null },
  "spendingClassification.preview": {
    method: "previewSpendingClassification",
    doc: null,
  },
  "spendingClassification.apply": {
    method: "applySpendingClassification",
    doc: null,
  },
  "ai.detectInventoryItems": { method: "detectInventoryItems", doc: null },
  "ai.approveDetectedInventoryItem": {
    method: "approveDetectedInventoryItem",
    doc: null,
  },
  "ai.suggestFieldsReview": { method: "suggestFieldsReview", doc: null },
  "ai.applyFinanceCategorySuggestion": {
    method: "applyFinanceCategorySuggestion",
    doc: null,
  },
  "financialTransaction.previewBookingCorrection": {
    method: "previewFinancialBookingCorrection",
    doc: null,
  },
  "financialTransaction.commitBookingCorrection": {
    method: "commitFinancialBookingCorrection",
    doc: null,
  },
  "problems.resolveRunFinding": { method: "resolveRunFinding", doc: null },
  "financialTransaction.previewBooking": {
    method: "previewFinancialBooking",
    doc: null,
  },
  "financialTransaction.commitBooking": {
    method: "commitFinancialBooking",
    doc: null,
  },
  "entity.listBase": { method: "entityListBase", doc: null },
  "entity.listEnrichment": { method: "entityListEnrichment", doc: null },
  "entity.listSummary": { method: "entityListSummary", doc: null },
  "entity.detailActivity": { method: "detailActivity", doc: null },
  "entity.monthlyExpenseSpend": { method: "monthlyExpenseSpend", doc: null },
  "dashboard.counts": { method: "dashboardCounts", doc: null },
  "inventory.confirmOwnership": {
    method: "confirmInventoryOwnership",
    doc: "Pins the currently inferred owner using the evidence fingerprint returned with the detail. The server rejects stale evidence so native cannot confirm a different acquisition than the one the person reviewed.",
  },
  "inventory.setOwnership": {
    method: "setInventoryOwnership",
    doc: "Applies a stored ownership choice to all or part of one inventory row. A partial quantity may split the row; callers must refresh the returned entry ids rather than assuming the original row is the only record changed.",
  },
  "inventory.receivingContext": {
    method: "inventoryReceivingContext",
    doc: null,
  },
  "inventory.receiveExpense": { method: "receiveExpense", doc: null },
  // The hero-action runner's operations (`nativeHeroActionPlans`); it decodes its form values
  // into these typed inputs, so a contract change is a compile error here, not a silent 400.
  "inventory.bulkAdd": { method: "bulkAddInventory", doc: null },
  "product.discard": { method: "discardProduct", doc: null },
  "product.discardPreview": { method: "discardPreview", doc: null },
  "product.addToInventoryPreview": {
    method: "addToInventoryPreview",
    doc: null,
  },
  "dataQuality.setException": { method: "setDataException", doc: null },
  "dataQuality.clearException": { method: "clearDataException", doc: null },
  "imageProcessing.analyses": { method: "imageAnalyses", doc: null },
  "imageProcessing.status": { method: "imageProcessingStatus", doc: null },
  "imageProcessing.pull": { method: "pullCompanionImageProcessing", doc: null },
  "imageProcessing.complete": {
    method: "completeCompanionImageProcessing",
    doc: null,
  },
  "imageProcessing.release": {
    method: "releaseCompanionImageProcessing",
    doc: null,
  },
  "imageProcessing.renew": {
    method: "renewCompanionImageProcessing",
    doc: null,
  },
  "photoImport.candidates": { method: "photoProductCandidates", doc: null },
  "photoImport.chooseExisting": {
    method: "choosePhotoGroupProduct",
    doc: null,
  },
  "photoImport.commit": { method: "commitPhotoImport", doc: null },
  "photoImport.discardGroup": { method: "discardPhotoGroup", doc: null },
  "photoImport.admitBatch": { method: "admitPhotoImportBatch", doc: null },
  "photoImport.sealBatch": { method: "sealPhotoImportBatch", doc: null },
  "photoImport.registerLiveActivity": {
    method: "registerPhotoRunLiveActivity",
    doc: null,
  },
  "photoImport.endLiveActivity": {
    method: "endPhotoRunLiveActivity",
    doc: null,
  },
  "photoImport.registerNotification": {
    method: "registerPhotoRunNotification",
    doc: null,
  },
  "photoImport.endNotification": {
    method: "endPhotoRunNotification",
    doc: null,
  },
  "photoImport.excludeFailed": {
    method: "excludeFailedPhotoDescriptions",
    doc: null,
  },
  "photoImport.setProcessor": { method: "setPhotoRunProcessor", doc: null },
  "imageProcessing.retry": { method: "retryImageProcessing", doc: null },
  "photoImport.createRun": {
    method: "createPhotoRun",
    doc: "Starts a native-tagged photo-inventory run (`PhotoImportRunUploader`'s bulk-upload entry point). Distinct from the manifest-based `stage`/`commit` pair: a run has no per-photo destination, only ordered positions finalized in chunks.",
  },
  "photoImport.finalize": {
    method: "finalizePhotoRun",
    doc: "Finalizes one chunk (≤100 images) of a bulk upload into `input.runId`. Idempotent: a retry after a transport error replays safely, since a previously finalized image comes back in `alreadyFinalized` rather than erroring.",
  },
  "photoImport.reconcile": {
    method: "reconcilePhotoImport",
    doc: "Waits for any in-flight commit touching these rows, then returns one transactionally consistent status and direct-association snapshot.",
  },
  "photoImport.review": { method: "photoRunReview", doc: null },
  "photoImport.stage": { method: "stagePhotoImport", doc: null },
  "photoImport.startGrouping": { method: "startPhotoGrouping", doc: null },
  "problems.getCounts": { method: "problemCounts", doc: null },
  "run.workSnapshot": { method: "runWorkSnapshot", doc: null },
  "run.control": { method: "controlRun", doc: null },
  "run.retryStep": { method: "retryRunStep", doc: null },
  "run.commitPrepared": { method: "commitPreparedImport", doc: null },
} as const satisfies Readonly<
  Record<string, Readonly<{ method: string; doc: string | null }>>
>;

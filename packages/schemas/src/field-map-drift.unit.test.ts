import { describe, expect, it } from "vitest";
import { z } from "zod";
import { allEntities } from "./entity-manifest";

/**
 * Guards the contract each `generated<Entity>FieldSchemas` map (packages/
 * schemas/src/generated/entity-field-schemas.*.gen.ts) exists to enforce: a
 * canonical module composing an entity's schemas must REFERENCE the
 * generated per-field schema for any key it shares with the generated map,
 * not hand-copy it. A hand copy silently drifts from the generated source of
 * truth the moment either side changes.
 *
 * For every entity that has a generated entity-field-schemas map this walks
 * every exported `z.ZodObject` in that entity's canonical module and
 * asserts, for each shape key also present in the generated
 * `create`/`update`/`read` maps, that the shape's schema is the SAME
 * INSTANCE as the generated one — not merely structurally similar.
 * `.optional()`/`.nullable()`/`.describe()` all return new wrapper
 * instances, so a deliberately loosened or annotated field is a real
 * respelling, not a false positive; it belongs in `INTENTIONAL_RESPELLINGS`
 * below with a reason, not silently exempted here.
 *
 * `allEntities` (rather than a `node:fs` directory scan) is the entity
 * list: `packages/schemas`'s tsconfig has no `node` types (it is meant to
 * stay isomorphic — importable from Workers and the browser, not just
 * Node), so `node:fs`/`node:path`/`node:url` don't typecheck here. Every
 * entity in `allEntities` has a matching
 * `generated/entity-field-schemas.<entity>.gen.ts` file today (verified by
 * `entity-manifest.unit.test.ts` covering the same enum); a dynamic import
 * failure below is treated the same as a missing file either way.
 */

/**
 * Entities whose canonical module is not the mechanical kebab-case of the
 * generated-file entity name. `usda-food`'s map is composed inside `usda.ts`
 * (a dedicated, usda-food-only module), not a nonexistent `usda-food.ts`.
 *
 * `expense` and `task` are NOT listed here even though their generated maps
 * are actually composed inside `project.ts` (alongside `project` itself):
 * routing them there would walk project.ts's project-shaped exports against
 * generatedExpenseFieldSchemas/generatedTaskFieldSchemas (and vice versa),
 * producing false "drift" from coincidental key-name collisions (`name`,
 * `status`, `notes`, …) across three different entities' fields sharing one
 * file. Left unmapped, `expense`/`task` fall through to the "canonical
 * module does not exist" skip below, which is correct: this test can only
 * cover a generated map from its OWN dedicated module.
 */
const MODULE_OVERRIDES = {
  "usda-food": "usda",
};

/** The override for `entityName`, if any — `undefined` falls through to `toKebabCase`. */
function moduleOverride(entityName: string): string | undefined {
  return Object.hasOwn(MODULE_OVERRIDES, entityName)
    ? // SAFETY: Object.hasOwn just confirmed entityName is one of MODULE_OVERRIDES's own keys.
      MODULE_OVERRIDES[entityName as keyof typeof MODULE_OVERRIDES]
    : undefined;
}

function toKebabCase(entityName: string): string {
  return entityName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * `${entityName}::${exportName}::${key}` -> one-line reason the shape's
 * schema at that key is deliberately NOT the same instance as the generated
 * field map's schema. Every drift this test finds must land here (with a
 * real reason, not a placeholder) or be fixed at the source — see the
 * per-entity notes below for which is which.
 */
const INTENTIONAL_RESPELLINGS = {
  // --- product.ts: reviewed and intentional -------------------------------
  "product::productQuickCreatePayload::name":
    "quick-create keeps its own requiredName() label ('Product name'), not the generated create field's describe()/meta()",
  "product::productQuickCreatePayload::manufacturer":
    "quick-create defaults manufacturer to UNSPECIFIED_MANUFACTURER; the generated create field has no default",
  "product::productQuickCreatePayload::upc":
    "quick-create makes upc fully optional; the generated create field requires the key (though its value may be null)",
  "product::productQuickCreatePayload::expectedQuantity":
    "quick-create constrains expectedQuantity to a positive integer; the generated create field is a plain nullable number",
  "product::productMcpOut::price":
    "hand-written to pair with effectivePrice and document that pairing in its own describe(); same meaning as the generated read field (see productMcpFields comment in product.ts)",
  "product::productMcpOut::expectedQuantity":
    "mcp output constrains expectedQuantity to a positive integer; the generated read field is a plain nullable number",
  "product::productMcpOut::externalIds":
    "mcp output is a slimmer projection of externalIdOut (omits the raw id/isPrimary fields)",
  "product::productMcpOut::unitMappings":
    "mcp output uses the OUTPUT-shaped mcpUnitMappingOut; the generated create/update field is INPUT-shaped (unitMappingInput)",
  "product::productMcpDetailOut::price":
    "spreads productMcpFields — same reason as productMcpOut::price",
  "product::productMcpDetailOut::expectedQuantity":
    "spreads productMcpFields — same reason as productMcpOut::expectedQuantity",
  "product::productMcpDetailOut::externalIds":
    "spreads productMcpFields — same reason as productMcpOut::externalIds",
  "product::productMcpDetailOut::unitMappings":
    "spreads productMcpFields — same reason as productMcpOut::unitMappings",

  // --- product.ts: pre-existing hand copies in OTHER exports of the SAME
  // file. This PR's ownership of product.ts is scoped to exactly
  // `productQuickCreatePayload` and `productMcpFields` (see the task's
  // ownership rules) — every other export below is a pre-existing hand copy
  // this change does not touch, reported for follow-up the same as the
  // other entities' below. Most of `productUpdateData`'s keys are flagged
  // only because `.partial()` rewraps every field of
  // `generatedProductFieldSchemas.update` into a new `.optional()` instance —
  // a legitimate zod combinator, not a per-field hand copy — but the
  // identity check can't tell the difference, so they land here too.
  "product::productUpdateData::name":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::aliases":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::tags":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::upc":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::isbn":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::fdc_id":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::manufacturer":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::model":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::notes":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::expectedQuantity":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::category":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::ingredientId":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::price":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::unitMappings":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::externalIds":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::usdaUnavailable":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::stockTracked":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::pendingImageIds":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::removeImageIds":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productUpdateData::imageOrder":
    "unreviewed: pre-existing hand copy (out of ownership scope) — also: .partial() rewraps every field",
  "product::productBulkStockTrackedInput::stockTracked":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productApplyUpcInput::upc":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productFindOrCreateByUPCInput::upc":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productQuantityLedgerOut::expectedQuantity":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productLookupUpcOut::upc":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productCookbookRefOut::id":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productCookbookRefOut::name":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productWithMappingsOut::unitMappings":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productWithMappingsAndFoodOut::unitMappings":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productWithMappingsMcpEntityOut::externalIds":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productWithMappingsMcpEntityOut::unitMappings":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productWithMappingsAndFoodMcpEntityOut::externalIds":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productWithMappingsAndFoodMcpEntityOut::unitMappings":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productPickerItemOut::name":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productPickerItemOut::manufacturer":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productPickerItemOut::category":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productPickerItemOut::price":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productWithIngredientAndInventoryAndMappingsOut::unitMappings":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productListInventoryEntryOut::id":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productListInventoryEntryOut::createdAt":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productListInventoryEntryOut::updatedAt":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productListItemOut::unitMappings":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productListItemMcpEntityOut::externalIds":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productListItemMcpEntityOut::unitMappings":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productWithFoodOut::unitMappings":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productWithFoodMcpEntityOut::externalIds":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productWithFoodMcpEntityOut::unitMappings":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productTopLevelMcpEntityOut::externalIds":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productWithFoodAndSideEffectsOut::unitMappings":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productSummariesOut::images":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productSummariesOut::unitMappings":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productMcpImageOut::id":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productMcpImageOut::createdAt":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productMcpImageOut::updatedAt":
    "unreviewed: pre-existing hand copy (out of ownership scope)",
  "product::productMcpDetailOut::images":
    "unreviewed: pre-existing hand copy (out of ownership scope) — productMcpDetailOut's own `images` field, not part of productMcpFields",

  // --- pre-existing hand copies in OTHER entities' modules. NOT fixed here
  // (out of scope per this PR's file ownership — only product.ts is owned).
  // Found by running this test and reading off every remaining failure;
  // reported to the requester for follow-up cleanup. -----------------------
  // --- cookbook: pre-existing hand copies ---
  "cookbook::cookbookChapterSchema::id": "unreviewed: pre-existing hand copy",
  "cookbook::cookbookRecipeSchema::id": "unreviewed: pre-existing hand copy",
  "cookbook::cookbookSourceSchema::subjects":
    "unreviewed: pre-existing hand copy",
  // --- financialAccount: pre-existing hand copies ---
  "financialAccount::financialAccountFiltersSchema::provisional":
    "unreviewed: pre-existing hand copy",
  // --- financialTransaction: pre-existing hand copies ---
  "financialTransaction::financialReconciliationSummary::status":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialStatementImportPreviewRow::accountId":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialStatementImportPreviewRow::accountName":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialStatementImportPreviewRow::status":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialStatementImportPreviewRow::vendorInference":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialStatementImportRow::kind":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialStatementImportRow::merchant":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialStatementImportRow::notes":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialTransactionAllocationInput::amount":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialTransactionAllocationInput::purchaseId":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialTransactionAllocationOut::amount":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialTransactionAllocationOut::purchaseId":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialTransactionFiltersSchema::accountId":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialTransactionFiltersSchema::kind":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialTransactionFiltersSchema::merchant":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialTransactionFiltersSchema::purchaseId":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::financialTransactionFiltersSchema::status":
    "unreviewed: pre-existing hand copy",
  "financialTransaction::merchantVendorInferenceInput::merchant":
    "unreviewed: pre-existing hand copy",
  // --- image: pre-existing hand copies ---
  "image::attachFileResponse::contentType":
    "unreviewed: pre-existing hand copy",
  "image::attachFileResponse::filename": "unreviewed: pre-existing hand copy",
  "image::attachFileResponse::url": "unreviewed: pre-existing hand copy",
  "image::createFileUploadInput::contentType":
    "unreviewed: pre-existing hand copy",
  "image::createFileUploadInput::filename":
    "unreviewed: pre-existing hand copy",
  "image::createFileUploadInput::size": "unreviewed: pre-existing hand copy",
  "image::imageListFiltersSchema::status": "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::contentType":
    "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::createdAt":
    "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::detectedContentType":
    "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::filename":
    "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::height": "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::key": "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::renderStatus":
    "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::size": "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::storageStatus":
    "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::updatedAt":
    "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::url": "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::verifiedAt":
    "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::width": "unreviewed: pre-existing hand copy",
  "image::importImageFromUrlResponseSchema::filename":
    "unreviewed: pre-existing hand copy",
  "image::importImageFromUrlResponseSchema::key":
    "unreviewed: pre-existing hand copy",
  "image::importImageFromUrlResponseSchema::url":
    "unreviewed: pre-existing hand copy",
  "image::importImageFromUrlSchema::url": "unreviewed: pre-existing hand copy",
  "image::initiateDocumentUploadSchema::contentType":
    "unreviewed: pre-existing hand copy",
  "image::initiateDocumentUploadSchema::filename":
    "unreviewed: pre-existing hand copy",
  "image::initiateDocumentUploadSchema::size":
    "unreviewed: pre-existing hand copy",
  "image::initiateUploadWithoutEntityResponseSchema::key":
    "unreviewed: pre-existing hand copy",
  "image::initiateUploadWithoutEntityResponseSchema::url":
    "unreviewed: pre-existing hand copy",
  "image::initiateUploadWithoutEntitySchema::contentType":
    "unreviewed: pre-existing hand copy",
  "image::initiateUploadWithoutEntitySchema::filename":
    "unreviewed: pre-existing hand copy",
  "image::initiateUploadWithoutEntitySchema::size":
    "unreviewed: pre-existing hand copy",
  "image::mcpAttachFileInput::contentType":
    "unreviewed: pre-existing hand copy",
  "image::mcpAttachFileInput::filename": "unreviewed: pre-existing hand copy",
  "image::mcpAttachFileInput::url": "unreviewed: pre-existing hand copy",
  "image::projectImageSummarySchema::filename":
    "unreviewed: pre-existing hand copy",
  "image::imageWithEntitySchema::sha256": "unreviewed: pre-existing hand copy",
  "image::projectImageSummarySchema::url": "unreviewed: pre-existing hand copy",
  // --- ingredient: pre-existing hand copies ---
  "ingredient::ingredientFiltersSchema::usuallyOnHand":
    "unreviewed: pre-existing hand copy",
  "ingredient::ingredientMergeCandidateImpact::name":
    "unreviewed: pre-existing hand copy",
  "ingredient::ingredientResolveOrCreateResultOut::aliases":
    "unreviewed: pre-existing hand copy",
  "ingredient::ingredientResolveOrCreateResultOut::name":
    "unreviewed: pre-existing hand copy",
  // --- inventory: pre-existing hand copies ---
  "inventory::inventoryDetailProductOut::createdAt":
    "unreviewed: pre-existing hand copy",
  "inventory::inventoryDetailProductOut::id":
    "unreviewed: pre-existing hand copy",
  "inventory::inventoryDetailProductOut::updatedAt":
    "unreviewed: pre-existing hand copy",
  "inventory::inventoryListLocationOut::id":
    "unreviewed: pre-existing hand copy",
  "inventory::inventoryListProductOut::id":
    "unreviewed: pre-existing hand copy",
  "inventory::inventoryLocationIdsInput::placement":
    "unreviewed: pre-existing hand copy",
  "inventory::productInventoryEmbedOut::createdAt":
    "unreviewed: pre-existing hand copy",
  "inventory::productInventoryEmbedOut::id":
    "unreviewed: pre-existing hand copy",
  "inventory::productInventoryEmbedOut::updatedAt":
    "unreviewed: pre-existing hand copy",
  // --- ledgerParty: pre-existing hand copies ---
  "ledgerParty::ledgerPartyFiltersSchema::kind":
    "unreviewed: pre-existing hand copy",
  // --- ledgerTransfer: pre-existing hand copies ---
  "ledgerTransfer::ledgerSourceClaimOut::createdAt":
    "unreviewed: pre-existing hand copy",
  "ledgerTransfer::ledgerSourceClaimOut::updatedAt":
    "unreviewed: pre-existing hand copy",
  "ledgerTransfer::ledgerTransferFiltersSchema::fromPartyId":
    "unreviewed: pre-existing hand copy",
  "ledgerTransfer::ledgerTransferFiltersSchema::toPartyId":
    "unreviewed: pre-existing hand copy",
  // --- location: pre-existing hand copies ---
  "location::locationAncestorOut::name": "unreviewed: pre-existing hand copy",
  "location::locationAncestorOut::type": "unreviewed: pre-existing hand copy",
  "location::locationBulkUpdateParentInput::parentId":
    "unreviewed: pre-existing hand copy",
  "location::locationFiltersSchema::parentId":
    "unreviewed: pre-existing hand copy",
  "location::locationFiltersSchema::productId":
    "unreviewed: pre-existing hand copy",
  "location::locationIdentityProductOut::id":
    "unreviewed: pre-existing hand copy",
  "location::locationIdentityProductOut::name":
    "unreviewed: pre-existing hand copy",
  "location::locationListRefOut::name": "unreviewed: pre-existing hand copy",
  "location::locationListRefOut::type": "unreviewed: pre-existing hand copy",
  "location::locationOptionItemOut::aliases":
    "unreviewed: pre-existing hand copy",
  "location::locationOptionItemOut::name": "unreviewed: pre-existing hand copy",
  "location::locationOptionItemOut::type": "unreviewed: pre-existing hand copy",
  "location::locationParentOptionsOut::name":
    "unreviewed: pre-existing hand copy",
  "location::locationPathRefOut::name": "unreviewed: pre-existing hand copy",
  "location::locationPathRefOut::type": "unreviewed: pre-existing hand copy",
  "location::locationPickerItemOut::aliases":
    "unreviewed: pre-existing hand copy",
  "location::locationPickerItemOut::name": "unreviewed: pre-existing hand copy",
  "location::locationPickerItemOut::type": "unreviewed: pre-existing hand copy",
  "location::locationUpdateData::aliases": "unreviewed: pre-existing hand copy",
  "location::locationUpdateData::imageOrder":
    "unreviewed: pre-existing hand copy",
  "location::locationUpdateData::name": "unreviewed: pre-existing hand copy",
  "location::locationUpdateData::parentId":
    "unreviewed: pre-existing hand copy",
  "location::locationUpdateData::pendingImageIds":
    "unreviewed: pre-existing hand copy",
  "location::locationUpdateData::productId":
    "unreviewed: pre-existing hand copy",
  "location::locationUpdateData::removeImageIds":
    "unreviewed: pre-existing hand copy",
  "location::locationUpdateData::tags": "unreviewed: pre-existing hand copy",
  "location::locationUpdateData::type": "unreviewed: pre-existing hand copy",
  // --- meal: pre-existing hand copies ---
  "meal::getMealPreparationsOut::totals": "unreviewed: pre-existing hand copy",
  "meal::mealAddRecipeInput::sortOrder": "unreviewed: pre-existing hand copy",
  "meal::mealFiltersSchema::mealKind": "unreviewed: pre-existing hand copy",
  "meal::mealFiltersSchema::mealType": "unreviewed: pre-existing hand copy",
  "meal::mealMcpEntityOut::recipes": "unreviewed: pre-existing hand copy",
  "meal::mealRecipeIdInput::id": "unreviewed: pre-existing hand copy",
  "meal::mealRecipeInput::sortOrder": "unreviewed: pre-existing hand copy",
  "meal::mealRecipeOut::createdAt": "unreviewed: pre-existing hand copy",
  "meal::mealRecipeOut::id": "unreviewed: pre-existing hand copy",
  "meal::mealRecipeOut::sortOrder": "unreviewed: pre-existing hand copy",
  "meal::mealRecipeOut::updatedAt": "unreviewed: pre-existing hand copy",
  "meal::mealRecipeSummary::id": "unreviewed: pre-existing hand copy",
  "meal::mealRecipeSummary::name": "unreviewed: pre-existing hand copy",
  "meal::mealRecipeSummary::totals": "unreviewed: pre-existing hand copy",
  "meal::mealUpdateRecipeInput::id": "unreviewed: pre-existing hand copy",
  "meal::mealUpdateRecipeInput::sortOrder":
    "unreviewed: pre-existing hand copy",
  "meal::shoppingListItem::name": "unreviewed: pre-existing hand copy",
  "meal::unexpandedSubRecipeOut::name": "unreviewed: pre-existing hand copy",
  // --- project: pre-existing hand copies ---
  "project::actionableTaskOut::blockedByIds":
    "unreviewed: pre-existing hand copy",
  "project::actionableTaskOut::blockingIds":
    "unreviewed: pre-existing hand copy",
  "project::actionableTaskOut::createdAt": "unreviewed: pre-existing hand copy",
  "project::actionableTaskOut::id": "unreviewed: pre-existing hand copy",
  "project::actionableTaskOut::name": "unreviewed: pre-existing hand copy",
  "project::actionableTaskOut::status": "unreviewed: pre-existing hand copy",
  "project::actionableTaskOut::updatedAt": "unreviewed: pre-existing hand copy",
  "project::blockedReasonSchema::kind": "unreviewed: pre-existing hand copy",
  "project::embeddedProjectScopeSchema::locations":
    "unreviewed: pre-existing hand copy",
  "project::expenseAnalyzeReadyOut::status":
    "unreviewed: pre-existing hand copy",
  "project::expenseAnalyzeTooLargeOut::status":
    "unreviewed: pre-existing hand copy",
  "project::expenseCreateInput::name": "unreviewed: pre-existing hand copy",
  "project::expenseCreateInput::notes": "unreviewed: pre-existing hand copy",
  "project::expenseMatchCandidate::name": "unreviewed: pre-existing hand copy",
  "project::expenseMatchCandidate::notes": "unreviewed: pre-existing hand copy",
  "project::expenseMatchPurchaseContext::id":
    "unreviewed: pre-existing hand copy",
  "project::expenseOut::createdAt": "unreviewed: pre-existing hand copy",
  "project::expenseOut::id": "unreviewed: pre-existing hand copy",
  "project::expenseOut::name": "unreviewed: pre-existing hand copy",
  "project::expenseOut::notes": "unreviewed: pre-existing hand copy",
  "project::expenseOut::updatedAt": "unreviewed: pre-existing hand copy",
  "project::expenseUpdateData::name": "unreviewed: pre-existing hand copy",
  "project::expenseUpdateData::notes": "unreviewed: pre-existing hand copy",
  "project::expenseUpdateInput::id": "unreviewed: pre-existing hand copy",
  "project::projectDashboardFiltersSchema::locations":
    "unreviewed: pre-existing hand copy",
  "project::projectFilterOptionsOut::locations":
    "unreviewed: pre-existing hand copy",
  "project::projectFiltersSchema::kind": "unreviewed: pre-existing hand copy",
  "project::projectFiltersSchema::parentProjectId":
    "unreviewed: pre-existing hand copy",
  "project::projectFiltersSchema::status": "unreviewed: pre-existing hand copy",
  "project::projectOptionsOut::icon": "unreviewed: pre-existing hand copy",
  "project::projectOptionsOut::name": "unreviewed: pre-existing hand copy",
  "project::projectSharedWindowOut::endDate":
    "unreviewed: pre-existing hand copy",
  "project::projectSharedWindowOut::startDate":
    "unreviewed: pre-existing hand copy",
  "project::projectToolMatrixColumnOut::endDate":
    "unreviewed: pre-existing hand copy",
  "project::projectToolMatrixColumnOut::icon":
    "unreviewed: pre-existing hand copy",
  "project::projectToolMatrixColumnOut::kind":
    "unreviewed: pre-existing hand copy",
  "project::projectToolMatrixColumnOut::startDate":
    "unreviewed: pre-existing hand copy",
  "project::projectToolMatrixInput::locations":
    "unreviewed: pre-existing hand copy",
  "project::taskBoardMovePatch::status": "unreviewed: pre-existing hand copy",
  "project::taskBulkStatusInput::status": "unreviewed: pre-existing hand copy",
  "project::taskCreateInput::name": "unreviewed: pre-existing hand copy",
  "project::taskCreateInput::status": "unreviewed: pre-existing hand copy",
  "project::taskFiltersSchema::status": "unreviewed: pre-existing hand copy",
  "project::taskOut::blockedByIds": "unreviewed: pre-existing hand copy",
  "project::taskOut::blockingIds": "unreviewed: pre-existing hand copy",
  "project::taskOut::createdAt": "unreviewed: pre-existing hand copy",
  "project::taskOut::id": "unreviewed: pre-existing hand copy",
  "project::taskOut::name": "unreviewed: pre-existing hand copy",
  "project::taskOut::status": "unreviewed: pre-existing hand copy",
  "project::taskOut::updatedAt": "unreviewed: pre-existing hand copy",
  "project::taskTodayBriefingItemOut::id": "unreviewed: pre-existing hand copy",
  "project::taskTodayBriefingItemOut::name":
    "unreviewed: pre-existing hand copy",
  "project::taskTodayBriefingItemOut::status":
    "unreviewed: pre-existing hand copy",
  "project::taskUpdateData::blockedByIds": "unreviewed: pre-existing hand copy",
  "project::taskUpdateData::name": "unreviewed: pre-existing hand copy",
  "project::taskUpdateData::status": "unreviewed: pre-existing hand copy",
  "project::taskUpdateInput::id": "unreviewed: pre-existing hand copy",
  "project::toolGalleryInventoryEntryOut::id":
    "unreviewed: pre-existing hand copy",
  // --- purchase: pre-existing hand copies ---
  "purchase::productPurchaseOut::displayLabel":
    "unreviewed: pre-existing hand copy",
  "purchase::productPurchaseOut::orderId": "unreviewed: pre-existing hand copy",
  "purchase::productPurchaseOut::vendorName":
    "unreviewed: pre-existing hand copy",
  "purchase::purchaseCreateInput::pendingImageIds":
    "unreviewed: pre-existing hand copy",
  "purchase::purchaseFiltersSchema::financialReconciliation":
    "unreviewed: pre-existing hand copy",
  "purchase::purchaseFiltersSchema::orderId":
    "unreviewed: pre-existing hand copy",
  "purchase::purchaseFiltersSchema::reconciliation":
    "unreviewed: pre-existing hand copy",
  "purchase::purchaseFiltersSchema::vendorId":
    "unreviewed: pre-existing hand copy",
  "purchase::purchaseOut::createdAt": "unreviewed: pre-existing hand copy",
  "purchase::purchaseOut::documentCount": "unreviewed: pre-existing hand copy",
  "purchase::purchaseOut::expenseCount": "unreviewed: pre-existing hand copy",
  "purchase::purchaseOut::images": "unreviewed: pre-existing hand copy",
  "purchase::purchaseOut::orderUrl": "unreviewed: pre-existing hand copy",
  "purchase::purchaseOut::reconciliation": "unreviewed: pre-existing hand copy",
  "purchase::purchaseOut::unpricedExpenseCount":
    "unreviewed: pre-existing hand copy",
  "purchase::purchaseOut::updatedAt": "unreviewed: pre-existing hand copy",
  "purchase::purchaseOut::vendorLogo": "unreviewed: pre-existing hand copy",
  "purchase::purchaseOut::vendorName": "unreviewed: pre-existing hand copy",
  "purchase::purchaseUpdateData::imageOrder":
    "unreviewed: pre-existing hand copy",
  "purchase::purchaseUpdateData::removeImageIds":
    "unreviewed: pre-existing hand copy",
  // --- recipe: pre-existing hand copies ---
  "recipe::cookbookSummary::id": "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeCreateInput::meta": "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeCreateInput::name": "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeCreateInput::notes": "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeCreateInput::sections":
    "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeCreateInput::servings":
    "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeCreateInput::tags": "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeCreateInput::yield": "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeUpdateInput::id": "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeUpdateInput::meta": "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeUpdateInput::name": "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeUpdateInput::notes": "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeUpdateInput::sections":
    "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeUpdateInput::servings":
    "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeUpdateInput::tags": "unreviewed: pre-existing hand copy",
  "recipe::mcpRecipeUpdateInput::yield": "unreviewed: pre-existing hand copy",
  "recipe::recipeGraphOut::createdAt": "unreviewed: pre-existing hand copy",
  "recipe::recipeGraphOut::name": "unreviewed: pre-existing hand copy",
  "recipe::recipeGraphOut::notes": "unreviewed: pre-existing hand copy",
  "recipe::recipeGraphOut::sections": "unreviewed: pre-existing hand copy",
  "recipe::recipeGraphOut::servings": "unreviewed: pre-existing hand copy",
  "recipe::recipeGraphOut::source": "unreviewed: pre-existing hand copy",
  "recipe::recipeGraphOut::tags": "unreviewed: pre-existing hand copy",
  "recipe::recipeGraphOut::totals": "unreviewed: pre-existing hand copy",
  "recipe::recipeGraphOut::updatedAt": "unreviewed: pre-existing hand copy",
  "recipe::recipeGraphOut::yield": "unreviewed: pre-existing hand copy",
  "recipe::recipeInstructionInput::id": "unreviewed: pre-existing hand copy",
  "recipe::recipeListItemOut::createdAt": "unreviewed: pre-existing hand copy",
  "recipe::recipeListItemOut::images": "unreviewed: pre-existing hand copy",
  "recipe::recipeListItemOut::name": "unreviewed: pre-existing hand copy",
  "recipe::recipeListItemOut::notes": "unreviewed: pre-existing hand copy",
  "recipe::recipeListItemOut::servings": "unreviewed: pre-existing hand copy",
  "recipe::recipeListItemOut::source": "unreviewed: pre-existing hand copy",
  "recipe::recipeListItemOut::tags": "unreviewed: pre-existing hand copy",
  "recipe::recipeListItemOut::totals": "unreviewed: pre-existing hand copy",
  "recipe::recipeListItemOut::updatedAt": "unreviewed: pre-existing hand copy",
  "recipe::recipeListItemOut::yield": "unreviewed: pre-existing hand copy",
  "recipe::recipeMcpEntityOut::sections": "unreviewed: pre-existing hand copy",
  "recipe::recipeMcpListOut::meta": "unreviewed: pre-existing hand copy",
  "recipe::recipeRefOut::name": "unreviewed: pre-existing hand copy",
  "recipe::recipeSectionInput::id": "unreviewed: pre-existing hand copy",
  "recipe::recipeSectionInput::name": "unreviewed: pre-existing hand copy",
  "recipe::recipeSectionMcpEntityOut::createdAt":
    "unreviewed: pre-existing hand copy",
  "recipe::recipeSectionMcpEntityOut::name":
    "unreviewed: pre-existing hand copy",
  "recipe::recipeSectionMcpEntityOut::updatedAt":
    "unreviewed: pre-existing hand copy",
  "recipe::recipeSectionOut::createdAt": "unreviewed: pre-existing hand copy",
  "recipe::recipeSectionOut::id": "unreviewed: pre-existing hand copy",
  "recipe::recipeSectionOut::name": "unreviewed: pre-existing hand copy",
  "recipe::recipeSectionOut::updatedAt": "unreviewed: pre-existing hand copy",
  "recipe::recipeTopLevel::createdAt": "unreviewed: pre-existing hand copy",
  "recipe::recipeTopLevel::name": "unreviewed: pre-existing hand copy",
  "recipe::recipeTopLevel::notes": "unreviewed: pre-existing hand copy",
  "recipe::recipeTopLevel::servings": "unreviewed: pre-existing hand copy",
  "recipe::recipeTopLevel::source": "unreviewed: pre-existing hand copy",
  "recipe::recipeTopLevel::tags": "unreviewed: pre-existing hand copy",
  "recipe::recipeTopLevel::updatedAt": "unreviewed: pre-existing hand copy",
  "recipe::recipeTopLevel::yield": "unreviewed: pre-existing hand copy",
  "recipe::recipeUpdateData::imageOrder": "unreviewed: pre-existing hand copy",
  "recipe::recipeUpdateData::meta": "unreviewed: pre-existing hand copy",
  "recipe::recipeUpdateData::name": "unreviewed: pre-existing hand copy",
  "recipe::recipeUpdateData::notes": "unreviewed: pre-existing hand copy",
  "recipe::recipeUpdateData::pendingImageIds":
    "unreviewed: pre-existing hand copy",
  "recipe::recipeUpdateData::removeImageIds":
    "unreviewed: pre-existing hand copy",
  "recipe::recipeUpdateData::sections": "unreviewed: pre-existing hand copy",
  "recipe::recipeUpdateData::servings": "unreviewed: pre-existing hand copy",
  "recipe::recipeUpdateData::tags": "unreviewed: pre-existing hand copy",
  "recipe::recipeUpdateData::yield": "unreviewed: pre-existing hand copy",
  "recipe::recipeUsageOut::id": "unreviewed: pre-existing hand copy",
  "recipe::rowDiagnostic::id": "unreviewed: pre-existing hand copy",
  "recipe::rowDiagnostic::name": "unreviewed: pre-existing hand copy",
  // --- wish: pre-existing hand copies ---
  "wish::wishCandidateOut::id": "unreviewed: pre-existing hand copy",
  "wish::wishCandidateOut::name": "unreviewed: pre-existing hand copy",
  "wish::wishFiltersSchema::acquired": "unreviewed: pre-existing hand copy",
};

type FieldMap = Record<string, z.ZodType>;
interface GeneratedFieldSchemas {
  create?: FieldMap;
  update?: FieldMap;
  read?: FieldMap;
}

/**
 * Entities with no dedicated canonical module of their own — their generated
 * map is composed only inside another entity's module (see the
 * `MODULE_OVERRIDES` comment above for why that isn't walked instead). Kept
 * as an explicit allowlist so a FUTURE entity silently missing its module
 * still fails loudly instead of quietly joining the skip list.
 */
const EXPECTED_SKIPPED_ENTITIES = new Set(["expense", "task"]);

interface SkippedEntity {
  entityName: string;
  message: string;
}
const skipped: SkippedEntity[] = [];
const drifts: string[] = [];

interface EntityCase {
  entityName: string;
  moduleName: string;
}

const entityCases: EntityCase[] = allEntities.map((entityName) => ({
  entityName,
  moduleName: moduleOverride(entityName) ?? toKebabCase(entityName),
}));

for (const { entityName, moduleName } of entityCases) {
  let genModuleNamespace: unknown;
  try {
    genModuleNamespace = await import(
      /* @vite-ignore */ `./generated/entity-field-schemas.${entityName}.gen`
    );
  } catch {
    skipped.push({
      entityName,
      message: `entity "${entityName}" -> no generated/entity-field-schemas.${entityName}.gen.ts module found`,
    });
    continue;
  }
  // SAFETY: an ES module namespace object is always a plain string-keyed
  // object of exports; reinterpreting it as a record only enables the
  // Object.keys enumeration below, nothing here trusts any export's value
  // without checking it first.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- dynamic import target is computed, so its namespace shape is unknown ahead of time; only enumerated via Object.keys below, never trusted as any concrete shape.
  const genModule = genModuleNamespace as Record<string, unknown>;
  const fieldSchemasExportNames = Object.keys(genModule).filter((key) =>
    /^generated.*FieldSchemas$/.test(key),
  );
  if (fieldSchemasExportNames.length !== 1) {
    skipped.push({
      entityName,
      message: `entity "${entityName}" -> found ${fieldSchemasExportNames.length} generated*FieldSchemas exports in entity-field-schemas.${entityName}.gen.ts (expected exactly 1): ${fieldSchemasExportNames.join(", ") || "none"}`,
    });
    continue;
  }
  const [fieldSchemasExportName] = fieldSchemasExportNames;
  // SAFETY: the length check above guarantees exactly one element, so
  // fieldSchemasExportName is defined and is one of genModule's own keys.
  const generatedFieldSchemas = genModule[
    fieldSchemasExportName as string
  ] as GeneratedFieldSchemas;

  let canonicalModuleNamespace: unknown;
  try {
    canonicalModuleNamespace = await import(
      /* @vite-ignore */ `./${moduleName}`
    );
  } catch {
    skipped.push({
      entityName,
      message: `entity "${entityName}" -> expected canonical module "${moduleName}.ts", which does not exist (or failed to import)`,
    });
    continue;
  }
  // SAFETY: same as genModule above — an ES module namespace object is
  // always a plain string-keyed object of exports; only enumerated via
  // Object.entries below, each value checked with `instanceof` before use.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- canonical module path is computed per entity, so its namespace shape is unknown ahead of time; only enumerated via Object.entries below, each value checked with instanceof before use.
  const canonicalModule = canonicalModuleNamespace as Record<string, unknown>;

  for (const [exportName, exportValue] of Object.entries(canonicalModule)) {
    if (!(exportValue instanceof z.ZodObject)) continue;
    // SAFETY: exportValue was just confirmed to be a z.ZodObject, whose
    // `.shape` is always a string-keyed map of its field schemas.
    const fieldsByKey = exportValue.shape as Record<string, z.ZodType>;

    for (const [key, schema] of Object.entries(fieldsByKey)) {
      const generatedCandidates = [
        generatedFieldSchemas.create?.[key],
        generatedFieldSchemas.update?.[key],
        generatedFieldSchemas.read?.[key],
      ].filter((candidate): candidate is z.ZodType => candidate !== undefined);
      if (generatedCandidates.length === 0) continue; // key not on the generated map at all

      const isSameInstance = generatedCandidates.some((c) => c === schema);
      if (isSameInstance) continue;

      const respellingKey = `${entityName}::${exportName}::${key}`;
      if (respellingKey in INTENTIONAL_RESPELLINGS) continue;

      drifts.push(
        `${moduleName}.ts export "${exportName}" key "${key}" (entity "${entityName}") is not the same instance as generated${entityName[0]?.toUpperCase()}${entityName.slice(1)}FieldSchemas.{create,update,read}.${key}. Reference the generated map directly, or register "${respellingKey}" in INTENTIONAL_RESPELLINGS with a reason.`,
      );
    }
  }
}

describe("generated field-map drift", () => {
  it("skips only the entities known to have no dedicated canonical module", () => {
    const skippedEntityNames = new Set(skipped.map((s) => s.entityName));
    const unexpectedSkips = skipped.filter(
      (s) => !EXPECTED_SKIPPED_ENTITIES.has(s.entityName),
    );
    expect(unexpectedSkips.map((s) => s.message)).toEqual([]);
    // Conversely, if an expected skip stops happening (a module now exists),
    // this test should start covering it — surface that as a failure too.
    // missingExpectedSkips lists which entities from EXPECTED_SKIPPED_ENTITIES
    // (add module coverage or update that set if this fails).
    const missingExpectedSkips = [...EXPECTED_SKIPPED_ENTITIES].filter(
      (name) => !skippedEntityNames.has(name),
    );
    expect(missingExpectedSkips).toEqual([]);
  });

  // drifts lists every "module.ts export "x" key "y"..." message produced
  // above (add a fix or an INTENTIONAL_RESPELLINGS entry if this fails).
  it("reuses the generated field-schema instance for every shared key across every entity's canonical module", () => {
    expect(drifts).toEqual([]);
  });
});

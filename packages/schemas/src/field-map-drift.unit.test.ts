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
// Shared one-line reasons for causes that recur across many keys, so
// identical causes read identically instead of drifting in wording. Each is
// verified against the actual export it's attached to (not assumed) — see
// the per-entity comments below for specifics.
const PARTIAL_REWRAP =
  ".partial() rewraps every field of the generated update map into a new .optional() instance — a legitimate zod-combinator rewrap, not a per-field hand copy";
const DERIVE_UPDATE_REWRAP =
  "deriveUpdateData() rewraps every create field via z.optional() into a new instance — same class of legitimate combinator rewrap as .partial()";
const HAND_WRITTEN_IMAGE_ID_ARRAY =
  "update-only image/document-id array field (with its own .describe()), hand-written fresh rather than referencing the generated update map's instance for this key";
const IMAGE_READ_FIELD_HAND_COPY =
  "hand-copies generatedImageFieldSchemas.read.<key>'s shape into a bespoke response/summary schema instead of referencing it directly — real duplication, candidate for follow-up (see report)";
const IMAGE_NO_GENERATED_CREATE =
  "no generated create schema exists for image (generatedImageFieldSchemas.create is empty) — this describes client-supplied metadata for a not-yet-created row in the presigned-upload workflow, hand-validated independently";
const RECIPE_TOP_LEVEL_FIELDS =
  "sourced from the shared recipeTopLevelFields map (recipe-shared.ts) — a hand-declared object predating/paralleling generatedRecipeFieldSchemas.read, reused across recipeTopLevel/recipeGraphOut/recipeListItemOut/etc.; one shared root cause, not a per-export hand copy";
const PROJECT_UNIT_MAPPINGS_OUTPUT_TYPED =
  "read/output shape (array of unitMappingOut, each with its own id); the generated create/update field is INPUT-shaped (unitMappingInput) — read code never references a create/update field for this key";
const PROJECT_EXTERNAL_IDS_MCP_PROJECTION =
  "MCP entity result strips the child row's own storage-only id (externalIdOut.omit({id:true})) — slimmer projection of the read field, not a per-field hand copy";
const PROJECT_LOCATIONS_HAND_ARRAY =
  "hand-written z.array(z.string()).optional() variant of project's own `locations` field (filter/scope/roster context), not a reference to generatedProjectFieldSchemas.{create,update,read}.locations";
const TASK_EXPENSE_SHARED_MODULE_COLLISION =
  "task/expense's own generated field — generatedTaskFieldSchemas/generatedExpenseFieldSchemas are composed inside project.ts (see the file header note above MODULE_OVERRIDES on shared-module collisions); this key already references its OWN entity's generated map correctly, it just coincidentally shares a name with project's generated field and this walk runs per canonical module";
const INTENTIONAL_RESPELLINGS = {
  "inventory::inventoryLocationSnapshotInput::placement":
    "location-snapshot makes the generated read placement optional with a default of stock; the wrapper changes omission behavior while retaining the generated enum as its inner schema",
  // --- product.ts: reviewed and intentional -------------------------------
  "product::productQuickCreatePayload::name":
    "quick-create keeps its own requiredName() label ('Product name'), not the generated create field's describe()/meta()",
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

  "product::productUpdateData::removeImageIds":
    ".extend({removeImageIds: z.array(imageShortcode).optional()}) overrides the generated field with a fresh array literal",
  "product::productUpdateData::imageOrder":
    ".extend({imageOrder: z.array(imageShortcode).optional()}) overrides the generated field with a fresh array literal",
  "product::productBulkStockTrackedInput::stockTracked":
    "bulk-operation input applies one value across many product ids — hand-written z.boolean().nullable(), same meaning as generatedProductFieldSchemas.update.stockTracked but not a reference to it",
  "product::productApplyUpcInput::upc":
    "takes the shared `upc` validator imported from @cubby/usda-schemas (used across USDA lookup flows), not generatedProductFieldSchemas.{create,update}.upc — same barcode format, different declared instance",
  "product::productFindOrCreateByUPCInput::upc":
    "takes the shared `upc` validator imported from @cubby/usda-schemas (used across USDA lookup flows), not generatedProductFieldSchemas.{create,update}.upc — same barcode format, different declared instance",
  "product::productQuantityLedgerOut::expectedQuantity":
    "derived ledger computation (acquiredUnits - exitedUnits, see repo/product/quantity-ledger.ts) — plain z.number() that can legitimately go negative, unlike the generated nullable-int field",
  "product::productLookupUpcOut::upc":
    "the raw barcode string as looked up (may not resolve to anything) — plain z.string(), not the generated field's GTIN-shaped constraint",
  "product::productCookbookRefOut::id":
    "coincidental key-name collision: this is the referenced COOKBOOK's own id (a lightweight cookbook reference embedded on a product), not the product's own id",
  "product::productCookbookRefOut::name":
    "coincidental key-name collision: this is the referenced COOKBOOK's own title, not the product's own name",
  "product::productWithMappingsOut::unitMappings":
    PROJECT_UNIT_MAPPINGS_OUTPUT_TYPED,
  "product::productWithMappingsAndFoodOut::unitMappings":
    PROJECT_UNIT_MAPPINGS_OUTPUT_TYPED,
  "product::productWithMappingsMcpEntityOut::externalIds":
    PROJECT_EXTERNAL_IDS_MCP_PROJECTION,
  "product::productWithMappingsMcpEntityOut::unitMappings":
    PROJECT_UNIT_MAPPINGS_OUTPUT_TYPED,
  "product::productWithMappingsAndFoodMcpEntityOut::externalIds":
    PROJECT_EXTERNAL_IDS_MCP_PROJECTION,
  "product::productWithMappingsAndFoodMcpEntityOut::unitMappings":
    PROJECT_UNIT_MAPPINGS_OUTPUT_TYPED,
  "product::productPickerItemOut::name":
    "picker-row projection (see file comment: same split as location's picker/roster items) — hand-copied name field, narrower row shape than the read schema",
  "product::productPickerItemOut::manufacturer":
    "picker-row projection — hand-copied manufacturer field, narrower row shape than the read schema",
  "product::productPickerItemOut::category":
    "picker-row projection — hand-copied category field, narrower row shape than the read schema",
  "product::productResolveNameOut::name":
    "the REQUESTED name echoed back (the caller's receipt line, trimmed), not the product's name field — coincidental key-name collision",
  "product::productResolveCandidateOut::price":
    "resolve candidates are picker rows: same positiveMoneyNullable narrowing as productPickerItemOut::price",
  "product::productPickerItemOut::price":
    "picker row deliberately constrains price to positiveMoneyNullable (see the file comment above it: 'kept as-is rather than silently loosened') — value-space narrowing over the generated plain moneyNullable read field",
  "product::productWithIngredientAndInventoryAndMappingsOut::unitMappings":
    PROJECT_UNIT_MAPPINGS_OUTPUT_TYPED,
  "product::productListInventoryEntryOut::id":
    "coincidental key-name collision: embeds the INVENTORY entry's own id (via productInventoryFields), not the product's own id",
  "product::productListInventoryEntryOut::createdAt":
    "coincidental key-name collision: embeds the INVENTORY entry's own createdAt (via productInventoryFields/timestampedFields), not the product's own createdAt",
  "product::productListInventoryEntryOut::updatedAt":
    "coincidental key-name collision: embeds the INVENTORY entry's own updatedAt (via productInventoryFields/timestampedFields), not the product's own updatedAt",
  "product::productListItemOut::unitMappings":
    PROJECT_UNIT_MAPPINGS_OUTPUT_TYPED,
  "product::productListItemMcpEntityOut::externalIds":
    PROJECT_EXTERNAL_IDS_MCP_PROJECTION,
  "product::productListItemMcpEntityOut::unitMappings":
    PROJECT_UNIT_MAPPINGS_OUTPUT_TYPED,
  "product::productWithFoodOut::unitMappings":
    PROJECT_UNIT_MAPPINGS_OUTPUT_TYPED,
  "product::productWithFoodMcpEntityOut::externalIds":
    PROJECT_EXTERNAL_IDS_MCP_PROJECTION,
  "product::productWithFoodMcpEntityOut::unitMappings":
    PROJECT_UNIT_MAPPINGS_OUTPUT_TYPED,
  "product::productTopLevelMcpEntityOut::externalIds":
    PROJECT_EXTERNAL_IDS_MCP_PROJECTION,
  "product::productWithFoodAndSideEffectsOut::unitMappings":
    PROJECT_UNIT_MAPPINGS_OUTPUT_TYPED,
  "product::productSummariesOut::images":
    "batched multi-product summary map (productImageSummariesOut, keyed by product id for a bounded batch), not the single-product read field",
  "product::productSummariesOut::unitMappings":
    "batched multi-product summary map (productUnitMappingSummariesOut, keyed by product id for a bounded batch), not the single-product read field",
  "product::productMcpImageOut::id":
    "coincidental key-name collision: embeds the IMAGE's own imageShortcode id, not the product's own id",
  "product::productMcpImageOut::createdAt":
    "coincidental key-name collision: embeds the IMAGE's own createdAt, not the product's own createdAt",
  "product::productMcpImageOut::updatedAt":
    "coincidental key-name collision: embeds the IMAGE's own updatedAt, not the product's own updatedAt",
  "product::productMcpDetailOut::images":
    "uses the MCP-projected productMcpImageOut shape (imageShortcode id, no raw uuid) rather than the generated read.images field's imageOut shape — productMcpDetailOut's own field, not part of productMcpFields",

  // --- pre-existing hand copies in OTHER entities' modules. NOT fixed here
  // (out of scope per this PR's file ownership — only product.ts is owned).
  // Found by running this test with the allowlist emptied and reading the
  // actual export at each key (read-only); reported to the requester for
  // follow-up cleanup. -----------------------------------------------------

  // --- cookbook: parsed-EPUB book-tree shapes, coincidentally named the
  // same as Cubby's own cookbook fields (generatedCookbookFieldSchemas.read
  // has id/subjects for the Cubby entity; these are the SOURCE file's raw
  // structure, captured before/around import) ---
  "cookbook::cookbookChapterSchema::id":
    "parsed EPUB book-tree chapter id (raw string from the source file), not Cubby's own cookbook shortcode id — coincidental key-name collision",
  "cookbook::cookbookRecipeSchema::id":
    "parsed EPUB book-tree recipe-item id (raw string from the source file), not Cubby's own cookbook shortcode id — coincidental key-name collision",
  "cookbook::cookbookSourceSchema::subjects":
    "raw subjects array as extracted from the source EPUB's own metadata (copied into Cubby's own `subjects` read field at import time, but validated independently here) — coincidental key-name collision",

  // --- financialTransaction: pre-existing hand copies ---
  "financialTransaction::financialReconciliationSummary::status":
    "financialReconciliationSummary is imported from ./financial-reconciliation, not financial-transaction.ts's own generated map — a settlement-evidence status enum, unrelated to financialTransaction's own generated `status` field",
  "financialTransaction::financialStatementImportPreviewRow::accountId":
    "statement-import preview row references the FinancialAccount being imported into, hand-typed for the import-preview payload — not financialTransaction's own generated accountId instance",
  "financialTransaction::financialStatementImportPreviewRow::accountName":
    "statement-import preview row's display label for the target account — no generated counterpart exists for this key",
  "financialTransaction::financialStatementImportPreviewRow::status":
    "statement-import preview row's own per-row import status (e.g. would-create/would-skip), coincidentally named the same as financialTransaction's own generated status field but a different value set",
  "financialTransaction::financialStatementImportPreviewRow::vendorInference":
    "statement-import preview row's inferred-vendor payload — no generated counterpart exists for this key",
  "financialTransaction::financialStatementImportRow::kind":
    "raw statement-row input kind (as parsed from the imported file), hand-declared for the import boundary — not a reference to the generated create/update/read instance",
  "financialTransaction::financialStatementImportRow::merchant":
    "raw statement-row input merchant string (as parsed from the imported file) — hand-declared for the import boundary, not the generated field instance",
  "financialTransaction::financialStatementImportRow::notes":
    "raw statement-row input notes (as parsed from the imported file) — hand-declared for the import boundary, not the generated field instance",
  "financialTransaction::financialTransactionAllocationInput::amount":
    "allocation sub-object's own amount (wholeCentAmount — a portion of a transaction split across purchases), not the same instance as the generated amount field, which validates the TRANSACTION's total signed amount (financialTransactionNonZeroAmount) — same underlying money type, different instance and a different quantity",
  "financialTransaction::financialTransactionAllocationInput::purchaseId":
    "allocation sub-object requires a specific non-null purchaseId (bare purchaseShortcode) — splitting a transaction's amount across purchases needs a real target — while the transaction-level generated purchaseId field is nullable (a transaction need not be linked to any purchase)",
  "financialTransaction::financialTransactionAllocationOut::amount":
    "same financialTransactionAllocation schema as financialTransactionAllocationInput::amount (aliased, not a separate declaration) — see that entry",
  "financialTransaction::financialTransactionAllocationOut::purchaseId":
    "same financialTransactionAllocation schema as financialTransactionAllocationInput::purchaseId (aliased, not a separate declaration) — see that entry",
  "financialTransaction::financialTransactionFiltersSchema::accountId":
    "shortcode-list filter spelled as entityFilterList(financialAccountShortcode) over the generated scalar accountId field",
  "financialTransaction::financialTransactionFiltersSchema::purchaseId":
    "shortcode-list filter spelled as entityFilterList(purchaseShortcode) over the generated scalar purchaseId field",
  "financialTransaction::merchantVendorInferenceInput::merchant":
    "standalone vendor-inference tool input (`{ merchant: z.string() }`) — a required plain string for a one-off lookup, not the generated filter/create field",

  // --- image: see the shared IMAGE_* constants above for the recurring
  // causes (no generated create schema exists at all; MCP-tool `.describe()`
  // prose; full hand-copies of the read shape into bespoke response schemas) ---
  "image::attachFileResponse::contentType": IMAGE_READ_FIELD_HAND_COPY,
  "image::attachFileResponse::filename": IMAGE_READ_FIELD_HAND_COPY,
  "image::attachFileResponse::url": IMAGE_READ_FIELD_HAND_COPY,
  "image::createFileUploadInput::contentType": IMAGE_NO_GENERATED_CREATE,
  "image::createFileUploadInput::filename": IMAGE_NO_GENERATED_CREATE,
  "image::createFileUploadInput::size": IMAGE_NO_GENERATED_CREATE,
  "image::imageWithEntitySchema::contentType": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::createdAt": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::dataQuality":
    "wraps the generated dataQuality field in .optional(): imageWithRelationsToAPI builds the base row without it, and every real producer (imageList/getImageById/getImagesByShortcodes) merges in the batch-loaded score afterward, the same postprocessed-field pattern imageWithEntitySchema already uses for representations/processingIssue/importTarget/analysisSummary",
  "image::imageWithEntitySchema::detectedContentType":
    IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::filename": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::height": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::key": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::renderStatus": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::size": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::storageStatus": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::updatedAt": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::url": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::verifiedAt": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::width": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageWithEntitySchema::sha256": IMAGE_READ_FIELD_HAND_COPY,
  "image::imageListFiltersSchema::capturedByPartyId":
    "shortcode-list filter (entityFilterList(ledgerPartyShortcode)) over the derived capturedByPartyId column — declared idMulti/urlOnly in the manifest (no stored descriptor, needs shortcode resolution), same as the existing hand-added importRunId filter above it",
  "image::importImageFromUrlResponseSchema::filename":
    IMAGE_READ_FIELD_HAND_COPY,
  "image::importImageFromUrlResponseSchema::key": IMAGE_READ_FIELD_HAND_COPY,
  "image::importImageFromUrlResponseSchema::url": IMAGE_READ_FIELD_HAND_COPY,
  "image::importImageFromUrlSchema::url":
    "external-URL import input — a plain z.url() the server fetches from, not any generated field (image has no generated create schema)",
  "image::storedImageEmbeddedMetadataSchema::capturedAt":
    "the embedded-EXIF blob's own capturedAt (a jsonb-nested ISO string read from an image's bytes), not the top-level Image.capturedAt column it seeds — coincidental key-name collision, see image-metadata.ts",
  "image::storedImageEmbeddedMetadataSchema::capturedAtOffsetMinutes":
    "the embedded-EXIF blob's own offset, not the top-level Image.capturedAtOffsetMinutes column it seeds — same reason as storedImageEmbeddedMetadataSchema::capturedAt",
  "image::initiateDocumentUploadSchema::contentType": IMAGE_NO_GENERATED_CREATE,
  "image::initiateDocumentUploadSchema::filename": IMAGE_NO_GENERATED_CREATE,
  "image::initiateDocumentUploadSchema::size": IMAGE_NO_GENERATED_CREATE,
  "image::initiateUploadWithoutEntityResponseSchema::key":
    IMAGE_READ_FIELD_HAND_COPY,
  "image::initiateUploadWithoutEntityResponseSchema::url":
    IMAGE_READ_FIELD_HAND_COPY,
  "image::initiateUploadWithoutEntitySchema::contentType":
    IMAGE_NO_GENERATED_CREATE,
  "image::initiateUploadWithoutEntitySchema::filename":
    IMAGE_NO_GENERATED_CREATE,
  "image::initiateUploadWithoutEntitySchema::size": IMAGE_NO_GENERATED_CREATE,
  "image::initiateUploadWithoutEntitySchema::width": IMAGE_NO_GENERATED_CREATE,
  "image::initiateUploadWithoutEntitySchema::height": IMAGE_NO_GENERATED_CREATE,
  "image::mcpAttachFileInput::contentType":
    "MCP attach_files tool input (attachFileFields) — its own .describe() MCP prose; no generated create schema exists for image to reference either (generatedImageFieldSchemas.create is empty)",
  "image::mcpAttachFileInput::filename":
    "MCP attach_files tool input (attachFileFields) — its own .describe() MCP prose; no generated create schema exists for image to reference either (generatedImageFieldSchemas.create is empty)",
  "image::mcpAttachFileInput::url":
    "MCP attach_files tool input (attachFileFields) — its own .describe() MCP prose ('exactly one of url/data/uploadId'); no generated create schema exists for image to reference either (generatedImageFieldSchemas.create is empty)",
  "image::projectImageSummarySchema::filename": IMAGE_READ_FIELD_HAND_COPY,
  "image::projectImageSummarySchema::url": IMAGE_READ_FIELD_HAND_COPY,

  // --- ingredient ---
  "ingredient::ingredientMergeCandidateImpact::name":
    "merge-candidate preview projection (id/name plus derived counts for the keeper picker) — plain z.string() label, not sourced from generatedIngredientFieldSchemas.read.name",
  "ingredient::ingredientResolveOrCreateResultOut::aliases":
    "the resolved ingredient's own current aliases — hand-written z.array(z.string()) instead of referencing generatedIngredientFieldSchemas.read.aliases directly",
  "ingredient::ingredientResolveOrCreateResultOut::name":
    "echoes the caller's REQUESTED name (may differ from the resolved entity's own name — see the adjacent canonicalName field/comment), not the entity's own read `name` field",
  "ingredient::ingredientNameFilterInput::nameFilter":
    "standalone required-value input for a specific name-lookup tool (z.string(), not optional) — not the optional list filter generatedIngredientFilterFields.nameFilter",

  // --- inventory: embedded PRODUCT/LOCATION references coincidentally
  // share key names with inventory's own generated id/createdAt/updatedAt ---
  "inventory::inventoryDetailProductOut::createdAt":
    "coincidental key-name collision: embeds the PRODUCT's own createdAt (via productInventoryEmbedFields/timestampedFields), not the inventory entry's own createdAt",
  "inventory::inventoryDetailProductOut::id":
    "coincidental key-name collision: embeds the PRODUCT's own id (via productInventoryEmbedFields), not the inventory entry's own id",
  "inventory::inventoryDetailProductOut::updatedAt":
    "coincidental key-name collision: embeds the PRODUCT's own updatedAt (via productInventoryEmbedFields/timestampedFields), not the inventory entry's own updatedAt",
  "inventory::inventoryListLocationOut::id":
    "coincidental key-name collision: embeds the LOCATION's own id, not the inventory entry's own id",
  "inventory::inventoryListProductOut::id":
    "coincidental key-name collision: embeds the PRODUCT's own id, not the inventory entry's own id",
  "inventory::inventoryLocationIdsInput::placement":
    "accepts inventoryPlacementFilter (a multi-value placement set) for a bulk audit/session query, not the single-value placement validator generated for create/update/read",
  "inventory::productInventoryEmbedOut::createdAt":
    "coincidental key-name collision: embeds the PRODUCT's own createdAt (via productInventoryEmbedFields/timestampedFields), not the inventory entry's own createdAt",
  "inventory::productInventoryEmbedOut::id":
    "coincidental key-name collision: embeds the PRODUCT's own id (via productInventoryEmbedFields), not the inventory entry's own id",
  "inventory::productInventoryEmbedOut::updatedAt":
    "coincidental key-name collision: embeds the PRODUCT's own updatedAt (via productInventoryEmbedFields/timestampedFields), not the inventory entry's own updatedAt",

  // --- ledgerTransfer ---
  "ledgerTransfer::ledgerSourceClaimOut::createdAt":
    "coincidental key-name collision: each source claim's OWN audit timestamp (a linked purchase/expense join row), not the ledgerTransfer's own createdAt",
  "ledgerTransfer::ledgerSourceClaimOut::updatedAt":
    "coincidental key-name collision: each source claim's OWN audit timestamp (a linked purchase/expense join row), not the ledgerTransfer's own updatedAt",
  "ledgerTransfer::ledgerTransferFiltersSchema::fromPartyId":
    "multi-value filter (oneOrMany(ledgerPartyShortcode)) over the generated scalar fromPartyId field",
  "ledgerTransfer::ledgerTransferFiltersSchema::toPartyId":
    "multi-value filter (oneOrMany(ledgerPartyShortcode)) over the generated scalar toPartyId field",

  // --- financialAccount ---
  "financialAccount::financialAccountFiltersSchema::ledgerPartyId":
    "multi-value filter (oneOrMany(ledgerPartyShortcode)) over the generated scalar ledgerPartyId field",

  // --- planting / gardenEntry: id filters over the generated scalar reference fields ---
  "planting::plantingFiltersSchema::locationId":
    "multi-value filter (oneOrMany(locationShortcode)) over the generated scalar locationId field",
  "planting::plantingFiltersSchema::ingredientId":
    "multi-value filter (oneOrMany(ingredientShortcode)) over the generated scalar ingredientId field",
  "planting::plantingFiltersSchema::taskId":
    "multi-value filter (oneOrMany(taskShortcode)) over the generated scalar taskId field",
  "planting::plantingFiltersSchema::sourceProductId":
    "multi-value filter (oneOrMany(productShortcode)) over the generated scalar sourceProductId field",
  "gardenEntry::gardenEntryFiltersSchema::locationId":
    "multi-value filter (oneOrMany(locationShortcode)) over the generated scalar locationId field",
  // --- location: picker/breadcrumb/ancestor-roster projections of
  // location's own name/type/aliases fields (see the file comments on each
  // export — deliberately narrower than the read schema, same split as
  // product's picker items), plus shortcode-list filters and a
  // deriveUpdateData() rewrap ---
  "location::locationAncestorOut::name":
    "ancestor-chain breadcrumb row (see file comment above locationAncestorFields) — hand-copied name field, narrower than the read schema",
  "location::locationAncestorOut::type":
    "ancestor-chain breadcrumb row — hand-copied type field, narrower than the read schema",
  "location::locationBulkUpdateParentInput::parentId":
    "bulk-reparent input's target parent id — a fresh optionalLocationShortcode reference for a bulk mutation, not generatedLocationFieldSchemas.{create,update}.parentId",
  "location::locationFiltersSchema::parentId":
    "shortcode-list filter spelled as entityFilterList(locationShortcode) over the generated scalar parentId field",
  "location::locationFiltersSchema::productId":
    "shortcode-list filter spelled as entityFilterList(productShortcode) over the generated scalar productId field",
  "location::locationIdentityProductOut::id":
    "coincidental key-name collision: embeds the PRODUCT this location IS (identity link) — the product's own id, not the location's own id",
  "location::locationIdentityProductOut::name":
    "coincidental key-name collision: embeds the PRODUCT this location IS — the product's own name, not the location's own name",
  "location::locationListRefOut::name":
    "roster/ref projection (id+name+type) — hand-copied name field, narrower than the read schema",
  "location::locationListRefOut::type":
    "roster/ref projection — hand-copied type field, narrower than the read schema",
  "location::locationOptionItemOut::aliases":
    "breadcrumb-only roster row (see file comment: deliberately NOT the full list-item shape) — hand-copied aliases field",
  "location::locationOptionItemOut::name":
    "breadcrumb-only roster row — hand-copied name field",
  "location::locationOptionItemOut::type":
    "breadcrumb-only roster row — hand-copied type field",
  "location::locationParentOptionsOut::name":
    "parent-picklist roster (see file comment: mirrors projectOptionsOut's role) — hand-copied name field",
  "location::locationPathRefOut::name":
    "path/breadcrumb ref projection — hand-copied name field, narrower than the read schema",
  "location::locationPathRefOut::type":
    "path/breadcrumb ref projection — hand-copied type field, narrower than the read schema",
  "location::locationPickerItemOut::aliases":
    "picker row (see file comment: adds a thumbnail over locationOptionItemOut) — hand-copied aliases field",
  "location::locationPickerItemOut::name":
    "picker row — hand-copied name field",
  "location::locationPickerItemOut::type":
    "picker row — hand-copied type field",
  "location::locationUpdateData::aliases": DERIVE_UPDATE_REWRAP,
  "location::locationUpdateData::name": DERIVE_UPDATE_REWRAP,
  "location::locationUpdateData::notes": DERIVE_UPDATE_REWRAP,
  "location::locationUpdateData::parentId": DERIVE_UPDATE_REWRAP,
  "location::locationUpdateData::pendingImageIds": DERIVE_UPDATE_REWRAP,
  "location::locationUpdateData::productId": DERIVE_UPDATE_REWRAP,
  "location::locationUpdateData::tags": DERIVE_UPDATE_REWRAP,
  "location::locationUpdateData::type": DERIVE_UPDATE_REWRAP,
  "location::locationUpdateData::imageOrder":
    "deriveUpdateData's `extend` option supplies its own z.array(imageShortcode).optional().describe(...) for this update-only field — a fresh instance, not the generated one",
  "location::locationUpdateData::removeImageIds":
    "deriveUpdateData's `extend` option supplies its own z.array(imageShortcode).optional().describe(...) for this update-only field — a fresh instance, not the generated one",

  // --- meal: the meal-recipe JOIN ROW's own fields (id/sortOrder/createdAt/
  // updatedAt) and embedded RECIPE/ingredient fields (name/totals) coincide
  // in key name with meal's own generated fields, since meal-recipe shapes
  // live in meal.ts/meal-fields.ts alongside meal's own generated map ---
  "meal::getMealPreparationsMcpOut::totals":
    "MCP variant of getMealPreparationsOut::totals with a partial nutrient record — same coincidental key-name collision with meal's scalar `totals` read field",
  "meal::getMealPreparationsOut::totals":
    "nested {confirmed, projected} nutrition-totals breakdown object — a different shape than meal's own scalar `totals` read field, coincidental key-name collision",
  "meal::mealAddRecipeInput::sortOrder":
    "the meal-recipe JOIN ROW's own sort position (its rank among recipes within one meal) — coincidental key-name collision with meal's own sortOrder (its rank among meals within a day)",
  "meal::removeMealFoodInput::id":
    "the MealFoodEntry child row's internal workflow id, distinct from the owning meal's public shortcode",
  "meal::mealFoodMutationOut::id":
    "the MealFoodEntry child row's internal workflow id, distinct from the owning meal's public shortcode",
  "meal::mealMcpEntityOut::recipes":
    "recipes: z.array(mealRecipeOut.omit({id: true})) — MealRecipe rows have no public shortcode (see file comment), a deliberately slimmer projection of the generated `recipes` read field",
  "meal::mealRecipeIdInput::id":
    "the meal-recipe JOIN ROW's own workflow id (mealRecipeId, a raw non-shortcode id — see the MCP server's documented exception), coincidental key-name collision with meal's own shortcode id",
  "meal::mealRecipeInput::sortOrder":
    "the meal-recipe JOIN ROW's own sort position — coincidental key-name collision with meal's own sortOrder, see mealAddRecipeInput::sortOrder",
  "meal::mealRecipeOut::createdAt":
    "the meal-recipe JOIN ROW's own audit timestamp (when this recipe was added to the meal) — coincidental key-name collision with meal's own createdAt",
  "meal::mealRecipeOut::id":
    "the meal-recipe JOIN ROW's own workflow id (mealRecipeId) — coincidental key-name collision with meal's own shortcode id, see mealRecipeIdInput::id",
  "meal::mealRecipeOut::sortOrder":
    "the meal-recipe JOIN ROW's own sort position — coincidental key-name collision with meal's own sortOrder, see mealAddRecipeInput::sortOrder",
  "meal::mealRecipeOut::updatedAt":
    "the meal-recipe JOIN ROW's own audit timestamp — coincidental key-name collision with meal's own updatedAt",
  "meal::mealRecipeSummary::id":
    "coincidental key-name collision: the embedded RECIPE's own id (recipeShortcode), not the meal's own id",
  "meal::mealRecipeSummary::name":
    "coincidental key-name collision: the embedded RECIPE's own name, not the meal's own name",
  "meal::mealRecipeSummary::totals":
    "coincidental key-name collision: the embedded RECIPE's own totals (recipeTotals), not the meal's own totals",
  "meal::mealUpdateRecipeInput::id":
    "the meal-recipe JOIN ROW's own workflow id (mealRecipeId) — coincidental key-name collision with meal's own shortcode id, see mealRecipeIdInput::id",
  "meal::mealUpdateRecipeInput::sortOrder":
    "the meal-recipe JOIN ROW's own sort position — coincidental key-name collision with meal's own sortOrder, see mealAddRecipeInput::sortOrder",
  "meal::shoppingListItem::name":
    "coincidental key-name collision: aggregatedNeedOut's own ingredient/product name (a shopping-list line), not the meal's own name",
  "meal::unexpandedSubRecipeOut::name":
    "coincidental key-name collision: the blocked SUB-RECIPE's own name, not the meal's own name",

  // --- project: task/expense's generated maps are composed inside
  // project.ts (see MODULE_OVERRIDES comment above) — every task::*/
  // expense::* entry below is that same coincidental shared-module
  // collision, not an independent hand copy. Verified by reading each
  // export directly (task/expenseCreateInput/UpdateData/Out all correctly
  // reference generatedTaskFieldSchemas/generatedExpenseFieldSchemas). ---
  "project::actionableTaskOut::blockedByIds":
    TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::actionableTaskOut::blockingIds":
    TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::actionableTaskOut::createdAt":
    "re-declares taskOut's shape by hand rather than extending it (see the file comment above actionableTaskOut: 'kept in sync by hand') — createdAt comes from the shared timestampedFields utility, not generatedTaskFieldSchemas.read's own instance",
  "project::actionableTaskOut::id": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::actionableTaskOut::name": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::actionableTaskOut::status": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::actionableTaskOut::updatedAt":
    "re-declares taskOut's shape by hand rather than extending it (see the file comment above actionableTaskOut: 'kept in sync by hand') — updatedAt comes from the shared timestampedFields utility, not generatedTaskFieldSchemas.read's own instance",
  "project::blockedReasonSchema::kind":
    'the blocking-chain node\'s own discriminator ("manual"|"task"|"project"), not project\'s own generated `kind` field — coincidental key-name collision',
  "project::embeddedProjectScopeSchema::locations":
    PROJECT_LOCATIONS_HAND_ARRAY,
  "project::expenseAnalyzeReadyOut::status":
    'discriminant literal tag for the expense-analyze result union (z.literal("ready")), not any entity\'s own workflow status field — coincidental key-name collision',
  "project::expenseAnalyzeTooLargeOut::status":
    'discriminant literal tag for the expense-analyze result union (z.literal("too_large")), not any entity\'s own workflow status field — coincidental key-name collision',
  "project::expenseCreateInput::name": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseCreateInput::notes": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseMatchCandidate::name":
    "expense-import-match preview row's own name (a candidate expense for import matching, not the persisted Expense) — hand-written, coincidentally colliding with project's generated name field since expense concepts live in project.ts",
  "project::expenseMatchCandidate::notes":
    "expense-import-match preview row's own notes — hand-written, coincidentally colliding with project's generated notes field since expense concepts live in project.ts",
  "project::expenseMatchPurchaseContext::id":
    "coincidental key-name collision: the referenced PURCHASE's own id (purchaseShortcode), not project's own id",
  "project::expenseOut::createdAt": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseOut::id": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseOut::name": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseOut::notes": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseOut::updatedAt": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  // expenseListItemOut = expenseOut + displayImages, same shared-module collision.
  "project::expenseListItemOut::createdAt":
    TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseListItemOut::id": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseListItemOut::name": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseListItemOut::notes": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseListItemOut::updatedAt":
    TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseUpdateData::name": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseUpdateData::notes": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseUpdateInput::id": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::projectDashboardFiltersSchema::locations":
    "projectDashboardFilterFields hand-writes its own `search`-adjacent locations: z.array(z.string()).optional() rather than referencing generatedProjectFieldSchemas.{create,update,read}.locations — same-entity hand copy, real duplication",
  "project::projectFilterOptionsOut::locations":
    "distinct-value roster of project location-name strings for filter option population — hand-written z.array(z.string()), not the generated locations field instance",
  "project::projectFiltersSchema::parentProjectId":
    "shortcode-list filter spelled as entityFilterList(projectShortcode) over the generated scalar parentProjectId field",
  "project::projectOptionsOut::icon":
    "picklist roster row (see file comment: mirrors locationParentOptionsOut's role) — hand-copied icon field, narrower than the read schema",
  "project::projectOptionsOut::name":
    "picklist roster row — hand-copied name field, narrower than the read schema",
  "project::projectSharedWindowOut::endDate":
    "computed shared usage-window bound (min/max across overlapping projects for the tool matrix) — a derived value, not project's own endDate override field, though same key name",
  "project::projectSharedWindowOut::startDate":
    "computed shared usage-window bound (min/max across overlapping projects for the tool matrix) — a derived value, not project's own startDate override field, though same key name",
  "project::projectToolMatrixColumnOut::endDate":
    "tool-matrix column header summarizing one project's own endDate (paired with endSource tracking override-vs-derived) — hand-copied read projection, not a reference to generatedProjectFieldSchemas.read.endDate",
  "project::projectToolMatrixColumnOut::icon":
    "tool-matrix column header summarizing one project's own icon — hand-copied read projection, not a reference to generatedProjectFieldSchemas.read.icon",
  "project::projectToolMatrixColumnOut::kind":
    "tool-matrix column header summarizing one project's own kind — hand-copied read projection, not a reference to generatedProjectFieldSchemas.read.kind",
  "project::projectToolMatrixColumnOut::startDate":
    "tool-matrix column header summarizing one project's own startDate (paired with startSource tracking override-vs-derived) — hand-copied read projection, not a reference to generatedProjectFieldSchemas.read.startDate",
  "project::projectToolMatrixInput::locations":
    "inherits projectDashboardFilterFields's hand-written locations field via spread — see projectDashboardFiltersSchema::locations",
  "project::taskBoardMovePatch::status": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskBulkStatusInput::status": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskCreateInput::name": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskCreateInput::status": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskFiltersSchema::search":
    "task's own generated search filter field (generatedTaskFilterFields.search, correctly referenced via taskFilterFields' spread) — coincidentally shares a name with project's own generated search filter field since both live in project.ts",
  "project::taskFiltersSchema::status":
    "task's own generated filter status field (generatedTaskFilterFields.status, correctly referenced via taskFilterFields' spread) — coincidentally shares a name with project's own generated status field since both live in project.ts",
  "project::taskFiltersSchema::dataStatus":
    TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskFiltersSchema::dataGap": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseFiltersSchema::search":
    "expense's own hand-written search filter (oneOrMany(z.string()); expense has no generated search key — see the file comment on why notes gets its own field) — coincidentally shares a name with project's own generated search filter field",
  "project::expenseFiltersSchema::dataStatus":
    TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::expenseFiltersSchema::dataGap":
    TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::embeddedProjectScopeSchema::search":
    "hand-written z.string().optional() duplicate of project's own generated search filter field, for the embeddable project-scope shape — same-entity hand copy, real duplication",
  "project::projectDashboardFiltersSchema::search":
    "hand-written z.string().optional() duplicate of project's own generated search filter field, for the dashboard-scoped filter shape — same-entity hand copy, real duplication",
  "project::toolGalleryInput::search":
    "value-space narrowing: z.string().trim().max(200).optional() bounds the tool-gallery search term more tightly than the generated field's plain z.string().optional()",
  "project::toolGalleryInventoryEntryOut::location":
    "coincidental key-name collision: an embedded location detail OBJECT ({id, name, ancestors}) on an inventory entry, entirely unrelated in shape to project's own generated `location` (oneOrMany(string)) exact-match filter field",
  "project::projectToolMatrixInput::search":
    "inherits projectDashboardFilterFields's hand-written search field via spread — see projectDashboardFiltersSchema::search",
  "project::taskOut::blockedByIds": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskOut::blockingIds": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskOut::createdAt": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskOut::id": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskOut::name": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskOut::status": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskOut::updatedAt": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  // taskListItemOut = taskOut + displayImages, same shared-module collision.
  "project::taskListItemOut::blockedByIds":
    TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskListItemOut::blockingIds": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskListItemOut::createdAt": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskListItemOut::id": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskListItemOut::name": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskListItemOut::status": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskListItemOut::updatedAt": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskTodayBriefingItemOut::id":
    "compact Today-briefing projection of TASK's own id (see file comment: 'the compact ready-work projection') — coincidentally shares a name with project's generated field since task concepts live in project.ts",
  "project::taskTodayBriefingItemOut::name":
    "compact Today-briefing projection of TASK's own name — coincidental key-name collision, see taskTodayBriefingItemOut::id",
  "project::taskTodayBriefingItemOut::status":
    'compact Today-briefing projection narrows TASK\'s own status to the two active/visible states ("not_started"|"in_progress") for the Today view — coincidental key-name collision with project\'s status field, plus a real value-space narrowing versus task\'s own full status enum',
  "project::taskUpdateData::blockedByIds": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskUpdateData::name": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskUpdateData::status": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::taskUpdateInput::id": TASK_EXPENSE_SHARED_MODULE_COLLISION,
  "project::toolGalleryInventoryEntryOut::id":
    "coincidental key-name collision: the embedded INVENTORY entry's own id, not project's own id",

  // --- purchase: product-embedded purchase-history rows hand-copy purchase's
  // own fields; filters use entityFilterList/oneOrMany multi-value variants
  // over generated scalars ---
  "purchase::productPurchaseOut::displayLabel":
    "product-purchase-history row hand-copies purchase's own displayLabel field for a product-embedded projection, rather than referencing generatedPurchaseFieldSchemas.read directly",
  "purchase::productPurchaseOut::orderId":
    "product-purchase-history row hand-copies purchase's own orderId field for a product-embedded projection, rather than referencing generatedPurchaseFieldSchemas.read directly",
  "purchase::productPurchaseOut::vendorName":
    "product-purchase-history row hand-copies purchase's own vendorName field for a product-embedded projection, rather than referencing generatedPurchaseFieldSchemas.read directly",
  "purchase::purchaseCreateInput::pendingImageIds":
    "purchaseCreateFields hand-declares pendingImageIds fresh (see file comment on Image minting a shortcode at insert time) rather than referencing the generated create field's instance",
  "purchase::purchaseFiltersSchema::financialReconciliation":
    'filter-only single-value enum (z.enum(["mismatch"])) over the read field\'s full financialReconciliationSummary object — same key name, entirely different shape (a filter predicate vs. the object it flags)',
  "purchase::purchaseFiltersSchema::orderId":
    "multi-value filter (oneOrMany(z.string())) over the generated scalar orderId field",
  "purchase::purchaseFiltersSchema::reconciliation":
    "multi-value filter (oneOrMany(purchaseReconciliation)) over the read field's single-value enum",
  "purchase::purchaseFiltersSchema::vendorId":
    "shortcode-list filter spelled as entityFilterList(vendorShortcode) over the generated scalar vendorId field",
  "purchase::purchaseUpdateData::imageOrder": HAND_WRITTEN_IMAGE_ID_ARRAY,
  "purchase::purchaseUpdateData::removeImageIds": HAND_WRITTEN_IMAGE_ID_ARRAY,

  // --- vendor account -----------------------------------------------------
  "vendorAccount::vendorAccountFilters::vendorId":
    "shortcode-list filter spelled as entityFilterList(vendorShortcode) over the generated scalar vendorId field",
  "vendorAccount::vendorAccountFilters::ledgerPartyId":
    "shortcode-list filter spelled as entityFilterList(ledgerPartyShortcode) over the generated scalar ledgerPartyId field",
  "importRun::importRunFilters::vendorAccountId":
    "shortcode-list filter spelled as entityFilterList(vendorAccountShortcode) over the generated scalar vendorAccountId field",
  "importRun::importRunFilters::vendorId":
    "shortcode-list filter spelled as entityFilterList(vendorShortcode) over the generated scalar vendorId field",
  "importRun::importRunFilters::ledgerPartyId":
    "shortcode-list filter spelled as entityFilterList(ledgerPartyShortcode) over the generated scalar ledgerPartyId field",

  // --- recipe: recipeTopLevelFields (recipe-shared.ts) is a hand-declared
  // shared map predating the generator, reused across many exports (one
  // root cause); section/usage/instruction sub-rows have their own ids
  // distinct from the recipe's own shortcode id (coincidental collisions);
  // MCP tool inputs add their own .describe() prose ---
  "recipe::cookbookSummary::id":
    "cookbookSummary = z.object(generatedCookbookFieldSchemas.read) — COOKBOOK's own generated read shape, correctly wired, embedded in recipe.ts because a recipe references its source cookbook; coincidentally shares the key name `id` with recipe's own generated field since this walk runs per canonical module",
  "recipe::mcpRecipeCreateInput::meta": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::mcpRecipeCreateInput::name":
    "MCP recipe create/update tool input (recipeWritableFields) hand-declares its own .describe() MCP prose for this field (see file comment: 'Descriptions surface to MCP clients...') — a distinct instance from generatedRecipeFieldSchemas.create",
  "recipe::mcpRecipeCreateInput::notes":
    "MCP recipe create/update tool input (recipeWritableFields) hand-declares its own .describe() MCP prose for this field — a distinct instance from generatedRecipeFieldSchemas.create",
  "recipe::mcpRecipeCreateInput::sections":
    "MCP recipe create/update tool input (recipeWritableFields) hand-declares its own .describe() MCP prose for this field (array of recipeSectionInput) — a distinct instance from generatedRecipeFieldSchemas.create",
  "recipe::mcpRecipeCreateInput::servings":
    "MCP recipe create/update tool input (recipeWritableFields) hand-declares its own .describe() MCP prose for this field — a distinct instance from generatedRecipeFieldSchemas.create",
  "recipe::mcpRecipeCreateInput::tags":
    "MCP recipe create/update tool input (recipeWritableFields) hand-declares its own .describe() MCP prose for this field — a distinct instance from generatedRecipeFieldSchemas.create",
  "recipe::mcpRecipeCreateInput::yield":
    "MCP recipe create/update tool input (recipeWritableFields) hand-declares its own .describe() MCP prose for this field — a distinct instance from generatedRecipeFieldSchemas.create",
  "recipe::mcpRecipeUpdateInput::id":
    "MCP update tool's target-row id parameter — its own recipeShortcode reference (paired with recipeWritableFields' MCP prose fields), not generatedRecipeFieldSchemas.read.id's instance",
  "recipe::mcpRecipeUpdateInput::meta": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::mcpRecipeUpdateInput::name":
    "MCP recipe create/update tool input (recipeWritableFields) hand-declares its own .describe() MCP prose for this field — a distinct instance from generatedRecipeFieldSchemas.update",
  "recipe::mcpRecipeUpdateInput::notes":
    "MCP recipe create/update tool input (recipeWritableFields) hand-declares its own .describe() MCP prose for this field — a distinct instance from generatedRecipeFieldSchemas.update",
  "recipe::mcpRecipeUpdateInput::sections":
    "MCP recipe create/update tool input (recipeWritableFields) hand-declares its own .describe() MCP prose for this field — a distinct instance from generatedRecipeFieldSchemas.update",
  "recipe::mcpRecipeUpdateInput::servings":
    "MCP recipe create/update tool input (recipeWritableFields) hand-declares its own .describe() MCP prose for this field — a distinct instance from generatedRecipeFieldSchemas.update",
  "recipe::mcpRecipeUpdateInput::tags":
    "MCP recipe create/update tool input (recipeWritableFields) hand-declares its own .describe() MCP prose for this field — a distinct instance from generatedRecipeFieldSchemas.update",
  "recipe::mcpRecipeUpdateInput::yield":
    "MCP recipe create/update tool input (recipeWritableFields) hand-declares its own .describe() MCP prose for this field — a distinct instance from generatedRecipeFieldSchemas.update",
  "recipe::recipeGraphOut::createdAt": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeGraphOut::forkedFromRecipeId": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeGraphOut::forkedFromRecipeName": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeGraphOut::name": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeGraphOut::notes": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeGraphOut::sections":
    "graph-shaped z.array(recipeSectionOut) (full output graph, ids included) vs. the generated create/update field's INPUT-shaped sections validator (array of recipeSectionInput)",
  "recipe::recipeGraphOut::servings": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeGraphOut::source": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeGraphOut::tags": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeGraphOut::totals":
    "recipe's own persisted totals, hand-declared fresh (recipeTotals.nullish()) rather than referencing generatedRecipeFieldSchemas.read.totals directly",
  "recipe::recipeGraphOut::updatedAt": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeGraphOut::yield": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeInstructionInput::id":
    "coincidental key-name collision: an instruction ROW's own optional edit-target uuid (id.optional()), not recipe's own shortcode id",
  "recipe::recipeListItemOut::createdAt": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeListItemOut::forkedFromRecipeId": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeListItemOut::forkedFromRecipeName": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeListItemOut::name": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeListItemOut::notes": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeListItemOut::servings": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeListItemOut::source": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeListItemOut::tags": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeListItemOut::totals":
    "recipe's own persisted totals, hand-declared fresh (recipeTotals.nullish()) — same cause as recipeGraphOut::totals",
  "recipe::recipeListItemOut::updatedAt": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeListItemOut::yield": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeMcpEntityOut::sections":
    "MCP entity result strips section/line storage-only ids (array of recipeSectionMcpEntityOut) — slimmer projection of the read field's sections, not a per-field hand copy",
  "recipe::recipeMcpListOut::meta": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeRefOut::name":
    "minimal recipe reference ({id, name} only) — picker/pointer projection, hand-written name instead of referencing generatedRecipeFieldSchemas.read.name",
  "recipe::recipeSectionInput::id":
    "coincidental key-name collision: a SECTION row's own optional edit-target uuid (id.optional()), not recipe's own shortcode id",
  "recipe::recipeSectionInput::name":
    "coincidental key-name collision: the SECTION's own optional name (min(2), nullable), not recipe's own name",
  "recipe::recipeSectionMcpEntityOut::createdAt":
    "coincidental key-name collision: the SECTION row's own audit timestamp (via recipeSectionFields/timestampedFields), not recipe's own createdAt",
  "recipe::recipeSectionMcpEntityOut::name":
    "coincidental key-name collision: the SECTION's own name, not recipe's own name",
  "recipe::recipeSectionMcpEntityOut::updatedAt":
    "coincidental key-name collision: the SECTION row's own audit timestamp, not recipe's own updatedAt",
  "recipe::recipeSectionOut::createdAt":
    "coincidental key-name collision: the SECTION row's own audit timestamp (via recipeSectionFields/timestampedFields), not recipe's own createdAt",
  "recipe::recipeSectionOut::id":
    "coincidental key-name collision: the SECTION's own uuid (declared exception: section ids have no shortcode), not recipe's own shortcode id",
  "recipe::recipeSectionOut::name":
    "coincidental key-name collision: the SECTION's own name, not recipe's own name",
  "recipe::recipeSectionOut::updatedAt":
    "coincidental key-name collision: the SECTION row's own audit timestamp, not recipe's own updatedAt",
  "recipe::recipeRefMcpEntityOut::name": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeRefMcpEntityOut::servings": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeRefMcpEntityOut::tags": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeRefMcpEntityOut::yield": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeTopLevel::createdAt": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeTopLevel::forkedFromRecipeId": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeTopLevel::forkedFromRecipeName": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeTopLevel::name": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeTopLevel::notes": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeTopLevel::servings": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeTopLevel::source": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeTopLevel::tags": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeTopLevel::updatedAt": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeTopLevel::yield": RECIPE_TOP_LEVEL_FIELDS,
  "recipe::recipeUpdateData::forkedFromRecipeId": PARTIAL_REWRAP,
  "recipe::recipeUpdateData::imageOrder": PARTIAL_REWRAP,
  "recipe::recipeUpdateData::meta": PARTIAL_REWRAP,
  "recipe::recipeUpdateData::name": PARTIAL_REWRAP,
  "recipe::recipeUpdateData::notes": PARTIAL_REWRAP,
  "recipe::recipeUpdateData::pendingImageIds": PARTIAL_REWRAP,
  "recipe::recipeUpdateData::removeImageIds": PARTIAL_REWRAP,
  "recipe::recipeUpdateData::sections": PARTIAL_REWRAP,
  "recipe::recipeUpdateData::servings": PARTIAL_REWRAP,
  "recipe::recipeUpdateData::tags": PARTIAL_REWRAP,
  "recipe::recipeUpdateData::yield": PARTIAL_REWRAP,
  "recipe::recipeUsageOut::id":
    "coincidental key-name collision: the usage ROW's own uuid (declared exception: a RecipeSectionIngredient usage row has no public shortcode), not recipe's own shortcode id",
  "recipe::rowDiagnostic::id":
    "costing-explain diagnostic row's generic id for EITHER an ingredient or a sub-recipe usage line (`kind` disambiguates) — plain z.string(), not recipe's own shortcode-typed id field",
  "recipe::rowDiagnostic::name":
    "costing-explain diagnostic row's generic name for either kind of usage line — plain z.string(), not recipe's own name field",

  // --- wish ---
  "wish::wishCandidateOut::id":
    "coincidental key-name collision: the candidate PRODUCT's own id (productShortcode) being matched against the wish item, not the wish item's own id",
  "wish::wishCandidateOut::name":
    "coincidental key-name collision: the candidate PRODUCT's own name, not the wish item's own name",

  // --- device / imageSighting: id-list filters over a single-reference field ---
  "device::deviceFilters::ledgerPartyId":
    "the ledgerPartyId filter descriptor is urlOnly (no deriveSchema), so entityFilterList(ledgerPartyShortcode).optional() is hand-added to accept one-or-many ids for URL filter state; the generated read schema for the same-named model field is a single nullable shortcode, a different shape by design",
  "imageSighting::imageSightingFilters::imageId":
    "the imageId filter descriptor is urlOnly (no deriveSchema), so entityFilterList(imageShortcode).optional() is hand-added to accept one-or-many ids for URL filter state; the generated create schema for the same-named model field is a single required shortcode, a different shape by design",
  "imageSighting::imageSightingFilters::ledgerPartyId":
    "same reason as imageSighting::imageSightingFilters::imageId, for the owner filter",
  "imageSighting::imageSightingFilters::deviceId":
    "same reason as imageSighting::imageSightingFilters::imageId, for the reporter filter",
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
/**
 * Every `entity::export::key` the walk actually checked against
 * INTENTIONAL_RESPELLINGS (i.e. found non-identical to its generated
 * candidate schema(s)). An allowlist entry the walk never reaches this way
 * is stale — the field it named was fixed, removed, or renamed — and is
 * caught by the "no stale entries" test below instead of silently rotting.
 */
const consultedRespellingKeys = new Set<string>();

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

  // Filter field maps (generated<Entity>FilterFields) are optional per
  // entity — cookbook/inventory/ledgerTransfer/usda-food have none — so
  // finding zero is not a skip condition the way a missing FieldSchemas
  // export is; every entity that HAS one composes it into a `<entity>
  // FilterFields` object spread into a `z.object(...)` filters schema, which
  // this walk already reaches as an ordinary exported ZodObject below.
  const [filterFieldsExportName] = Object.keys(genModule).filter((key) =>
    /^generated.*FilterFields$/.test(key),
  );
  let generatedFilterFields: FieldMap | undefined;
  if (filterFieldsExportName) {
    // SAFETY: filterFieldsExportName came from Object.keys(genModule) two
    // lines above, so it is one of genModule's own keys.
    generatedFilterFields = genModule[filterFieldsExportName] as FieldMap;
  }

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
        generatedFilterFields?.[key],
      ].filter((candidate): candidate is z.ZodType => candidate !== undefined);
      if (generatedCandidates.length === 0) continue; // key not on any generated map at all

      const isSameInstance = generatedCandidates.some((c) => c === schema);
      if (isSameInstance) continue;

      const respellingKey = `${entityName}::${exportName}::${key}`;
      consultedRespellingKeys.add(respellingKey);
      if (respellingKey in INTENTIONAL_RESPELLINGS) continue;

      drifts.push(
        `${moduleName}.ts export "${exportName}" key "${key}" (entity "${entityName}") is not the same instance as the generated schema in ${fieldSchemasExportName}.{create,update,read}${filterFieldsExportName ? ` or ${filterFieldsExportName}` : ""}. Reference the generated map directly, or register "${respellingKey}" in INTENTIONAL_RESPELLINGS with a reason.`,
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

  // A key listed here that the walk above never found non-identical is
  // stale: the field was fixed, renamed, or removed since the entry was
  // written, and the entry no longer documents anything real. Delete it
  // instead of letting it linger — a stale entry hides a REGRESSION if the
  // same key later drifts again for a different, unreviewed reason, because
  // "in INTENTIONAL_RESPELLINGS" would silently swallow it again.
  it("has no INTENTIONAL_RESPELLINGS entries the walk never consulted", () => {
    const staleRespellingKeys = Object.keys(INTENTIONAL_RESPELLINGS).filter(
      (key) => !consultedRespellingKeys.has(key),
    );
    expect(staleRespellingKeys).toEqual([]);
  });
});

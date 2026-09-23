import type { AiSmokeScenario } from "@cubby/schemas/ai-smoke";
import { aiSmokeInputs } from "@cubby/schemas/ai-smoke";
import { z } from "zod";

import {
  type AiFeature,
  ENTITY_EMBEDDING_FEATURE,
  FIELD_SUGGESTION_FEATURE,
  IMAGE_DESCRIPTION_FEATURE,
  INGREDIENT_MERGE_FEATURE,
  LOCATION_DESCRIPTION_FEATURE,
  LOCATION_INVENTORY_DETECTION_FEATURE,
  PRODUCT_IDENTIFICATION_FEATURE,
  PURCHASE_IMPORT_AUDIT_FEATURE,
  PURCHASE_IMPORT_EXPENSE_LINE_ROLE_FEATURE,
  PURCHASE_IMPORT_EXTRACTION_FEATURE,
  PURCHASE_IMPORT_KIT_DETECTION_FEATURE,
  PURCHASE_IMPORT_MAIL_FEATURE,
  PURCHASE_IMPORT_PRODUCT_IDENTITY_FEATURE,
  PURCHASE_IMPORT_PRODUCT_PROMOTION_FEATURE,
  PURCHASE_IMPORT_RECEIPT_FEATURE,
  PURCHASE_IMPORT_REPAIR_FEATURE,
  PURCHASE_IMPORT_REVERSAL_KIND_FEATURE,
  RECIPE_FLOW_PRIMARY_FEATURE,
  SELECTION_OVERFLOW_FEATURE,
  SEMANTIC_QUERY_FEATURE,
  USDA_FOOD_SUGGEST_FEATURE,
} from "./features";

type SmokeCase = {
  feature: AiFeature;
  label: string;
  description: string;
  group: string;
};

/** A scenario is one real caller shape, so a feature can have several. */
export const AI_SMOKE_CASES = {
  fieldSuggestions: {
    feature: FIELD_SUGGESTION_FEATURE,
    label: "Field suggestions",
    description: "Manifest target selection from a draft basis",
    group: "Decisions",
  },
  externalIdKind: {
    feature: FIELD_SUGGESTION_FEATURE,
    label: "External ID kind",
    description: "Classify a product identifier",
    group: "Decisions",
  },
  usdaFood: {
    feature: USDA_FOOD_SUGGEST_FEATURE,
    label: "USDA food",
    description: "Search and choose one food",
    group: "Decisions",
  },
  usdaFoodBatch: {
    feature: USDA_FOOD_SUGGEST_FEATURE,
    label: "USDA food batch",
    description: "Search and choose foods for ingredients",
    group: "Decisions",
  },
  ingredientMerge: {
    feature: INGREDIENT_MERGE_FEATURE,
    label: "Ingredient merge",
    description: "Select a merge candidate",
    group: "Decisions",
  },
  selectionOverflow: {
    feature: SELECTION_OVERFLOW_FEATURE,
    label: "Large shortlist",
    description: "Selection beyond Jev's roster limit",
    group: "Decisions",
  },
  productIdentification: {
    feature: PRODUCT_IDENTIFICATION_FEATURE,
    label: "Product identification",
    description: "Identify a product from images",
    group: "Vision",
  },
  locationDescription: {
    feature: LOCATION_DESCRIPTION_FEATURE,
    label: "Location description",
    description: "Describe a photographed location",
    group: "Vision",
  },
  inventoryDetection: {
    feature: LOCATION_INVENTORY_DETECTION_FEATURE,
    label: "Inventory detection",
    description: "Detect items in a photographed location",
    group: "Vision",
  },
  imageDescription: {
    feature: IMAGE_DESCRIPTION_FEATURE,
    label: "Image description",
    description: "Describe one uploaded image",
    group: "Vision",
  },
  recipeFlow: {
    feature: RECIPE_FLOW_PRIMARY_FEATURE,
    label: "Recipe flow",
    description: "Build a cooking dependency plan",
    group: "Recipes",
  },
  purchaseProductIdentity: {
    feature: PURCHASE_IMPORT_PRODUCT_IDENTITY_FEATURE,
    label: "Product identity",
    description: "Choose a matching product for a purchase line",
    group: "Purchase import",
  },
  purchaseExpenseLineRole: {
    feature: PURCHASE_IMPORT_EXPENSE_LINE_ROLE_FEATURE,
    label: "Expense line role",
    description: "Classify a purchase line's financial role",
    group: "Purchase import",
  },
  purchaseKitDetection: {
    feature: PURCHASE_IMPORT_KIT_DETECTION_FEATURE,
    label: "Kit detection",
    description: "Classify a sellable kit or pack",
    group: "Purchase import",
  },
  purchaseProductPromotion: {
    feature: PURCHASE_IMPORT_PRODUCT_PROMOTION_FEATURE,
    label: "Product promotion",
    description: "Decide whether a line identifies a product",
    group: "Purchase import",
  },
  purchaseReversalKind: {
    feature: PURCHASE_IMPORT_REVERSAL_KIND_FEATURE,
    label: "Reversal kind",
    description: "Classify a negative purchase line",
    group: "Purchase import",
  },
  purchaseExtraction: {
    feature: PURCHASE_IMPORT_EXTRACTION_FEATURE,
    label: "Capture extraction",
    description: "Extract a purchase from a captured page",
    group: "Purchase import",
  },
  purchaseReceipt: {
    feature: PURCHASE_IMPORT_RECEIPT_FEATURE,
    label: "Receipt extraction",
    description: "Extract purchase evidence from an image",
    group: "Purchase import",
  },
  purchaseMail: {
    feature: PURCHASE_IMPORT_MAIL_FEATURE,
    label: "Order mail",
    description: "Classify a vendor email",
    group: "Purchase import",
  },
  purchaseAudit: {
    feature: PURCHASE_IMPORT_AUDIT_FEATURE,
    label: "Import audit",
    description: "Audit assembled purchase data",
    group: "Purchase import",
  },
  purchaseRepair: {
    feature: PURCHASE_IMPORT_REPAIR_FEATURE,
    label: "Extraction repair",
    description: "Repair an invalid purchase extraction",
    group: "Purchase import",
  },
  semanticQuery: {
    feature: SEMANTIC_QUERY_FEATURE,
    label: "Semantic query",
    description: "Embed a search query",
    group: "Embeddings",
  },
  entityEmbedding: {
    feature: ENTITY_EMBEDDING_FEATURE,
    label: "Entity embedding",
    description: "Embed product search text",
    group: "Embeddings",
  },
} as const satisfies Record<AiSmokeScenario, SmokeCase>;

export const smokeCatalog = () =>
  // SAFETY: entries of the typed scenario table preserve its declared scenario keys.
  (Object.entries(AI_SMOKE_CASES) as [AiSmokeScenario, SmokeCase][]).map(
    ([id, spec]) => ({
      id,
      feature: spec.feature.feature,
      label: spec.label,
      description: spec.description,
      group: spec.group,
      model: spec.feature.model,
      tier: spec.feature.tier,
      inputSchema: z
        .json()
        .parse(JSON.parse(JSON.stringify(z.toJSONSchema(aiSmokeInputs[id])))),
    }),
  );

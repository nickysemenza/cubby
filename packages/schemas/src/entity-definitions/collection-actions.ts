/**
 * The verbs a report `records` block can offer, each implemented by both clients: web in
 * `entity/entity-detail/collection-actions.tsx`, native by a plan in `nativeCollectionActionPlans`
 * (`../native-coverage.ts`) that the generic hero-action runner executes. A `section` verb acts on
 * the record the slot belongs to; a `row` verb acts on one row (`$item.id`).
 */
export const COLLECTION_ACTIONS = [
  "analyzeLocation",
  "attachImage",
  "reviewLabelNutrition",
  "validatePurchase",
  "enrichProduct",
] as const;

export type CollectionActionId = (typeof COLLECTION_ACTIONS)[number];

export const COLLECTION_ACTION_SCOPES = {
  analyzeLocation: "section",
  attachImage: "section",
  reviewLabelNutrition: "row",
  validatePurchase: "section",
  enrichProduct: "section",
} as const satisfies Record<CollectionActionId, "section" | "row">;

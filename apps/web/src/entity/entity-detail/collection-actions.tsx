import type { CollectionActionId } from "@cubby/schemas/entity-definitions/collection-actions";
import type { ReportRecordRow } from "@cubby/schemas/entity-report";
import { type FunctionComponent, lazy, type LazyExoticComponent } from "react";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

/**
 * What a `collection` section hands an action: the loaded record, and for a `row` action the
 * row it was drawn on (`null` for a `section` action).
 */
export type CollectionActionProps<E extends GenericDetailEntity> = {
  record: DetailRecordOf<E>;
  item: ReportRecordRow | null;
};

type ActionModule<E extends GenericDetailEntity> = Promise<{
  default: FunctionComponent<CollectionActionProps<E>>;
}>;

const action = <E extends GenericDetailEntity>(load: () => ActionModule<E>) =>
  lazy(load);

/**
 * The web fill for every action a report `records` block can offer (native has a plan in
 * `nativeCollectionActionPlans`). Keyed by `CollectionActionId`, so a declared action without a
 * browser implementation fails to compile. Each is lazy: a detail route loads only the dialogs of
 * the actions its own sections declare. A component reads the record's entity, so the map is
 * erased to `never` for the section that renders any of them.
 */
export const collectionActions = {
  analyzeLocation: action<"location">(() =>
    import("~/app/locations/slots").then((m) => ({
      default: m.AnalyzeLocationAction,
    })),
  ),
  attachImage: action<"image">(() =>
    import("~/app/images/slots").then((m) => ({
      default: m.AttachImageAction,
    })),
  ),
  reviewLabelNutrition: action<"product">(() =>
    import("~/app/products/slots").then((m) => ({
      default: m.ReviewLabelNutritionAction,
    })),
  ),
  validatePurchase: action<"purchase">(() =>
    import("~/app/purchases/slots").then((m) => ({
      default: m.ValidatePurchaseAction,
    })),
  ),
  enrichProduct: action<"product">(() =>
    import("~/app/products/product-runs").then((m) => ({
      default: m.ProductEnrichmentAction,
    })),
  ),
} satisfies Record<
  CollectionActionId,
  LazyExoticComponent<FunctionComponent<CollectionActionProps<never>>>
>;

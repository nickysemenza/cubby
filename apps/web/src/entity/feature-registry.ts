import type { ComponentProps, ComponentType } from "react";

import type { EntityActionDefinition } from "~/entity/actions/entity-action-definition";
import type { EntityDetailFieldRenderers } from "~/entity/display/detail-field-renderers";
import type { ListRenderer } from "~/entity/display/list-renderer-types";
import type { EntityEditorMediaHook } from "~/entity/editing/editor-presentations";
import type { FeatureControlRenderers } from "~/entity/editing/entity-primitive-fields";
import type { CollectionActionTable } from "~/entity/entity-detail/collection-actions";
import type { HeaderActionTable } from "~/entity/entity-detail/detail-action-bar";
import type { DetailEditOverrideTable } from "~/entity/entity-detail/detail-edit-overrides";
import type { DetailSlotTable } from "~/entity/entity-detail/detail-slots";
import type { SectionActionTable } from "~/entity/entity-detail/section-actions";
import type { ListSlotTable } from "~/entity/entity-list/list-slots";
import type { FinancialTransactionFormFields } from "~/features/finance/financial-transaction-form";
import type { SpendingCategoryMergeReview } from "~/features/finance/spending-classification-review";
import type { EntityPhotosSection } from "~/features/image/entity-photos-section";
import type { useInventoryPlacementAction } from "~/features/inventory/inventory-placement-suggestion";
import type { ProductDiscardDialog } from "~/features/product/product-discard-dialog";
import type { useUpcAwareCreate } from "~/features/product/use-upc-aware-create";
import type { createUnitMappingsColumn } from "~/features/units/unit-mappings-column";

/**
 * The feature fills for the entity platform's extension points. `entity/`
 * owns each table's shape and its lookup; `features/registry.tsx` builds the
 * contents (lazy wherever the fill is a whole section, action or dialog, so a
 * route chunk carries only what its entity declares). Code-split entry points
 * (`routes/_authenticated.tsx`, the home route, the command menu) install it,
 * so feature code stays out of the Worker's first-request closure; route chunks
 * load before SSR render and hydration. Lookups read the registry at call
 * time, never at import time.
 */
export interface FeatureRegistry {
  detailSlots: DetailSlotTable;
  listSlots: ListSlotTable;
  headerActions: HeaderActionTable;
  sectionActions: SectionActionTable;
  collectionActions: CollectionActionTable;
  detailEditOverrides: DetailEditOverrideTable;
  detailFieldRenderers: {
    expense: EntityDetailFieldRenderers<"expense">;
    financialTransaction: EntityDetailFieldRenderers<"financialTransaction">;
  };
  listRenderers: {
    financialTransaction: Readonly<
      Record<"possible-vendor", ListRenderer<"financialTransaction">>
    >;
    location: Readonly<
      Record<"product-link" | "valuation-summary", ListRenderer<"location">>
    >;
    purchase: Readonly<
      Record<
        | "vendor-cell"
        | "order-link"
        | "financial-settlement"
        | "reconciliation-status",
        ListRenderer<"purchase">
      >
    >;
  };
  /** Specialized edit controls owned by product and finance features. */
  controlRenderers: FeatureControlRenderers;
  /** Product's edit-dialog media block (identify action, label images, manuals). */
  productMedia: EntityEditorMediaHook;
  /** Feature-owned entity actions, spliced into the registry at their declared order. */
  entityActions: {
    addToInventory: EntityActionDefinition;
    discardInventory: EntityActionDefinition;
    recipe: readonly EntityActionDefinition[];
    inventoryLocation: readonly EntityActionDefinition[];
    markExpensePurchased: EntityActionDefinition;
    createProjectFromTasks: EntityActionDefinition;
  };
  /** Feature components and hooks the generic entity surfaces render. */
  components: {
    ProductDiscardDialog: typeof ProductDiscardDialog;
    SpendingCategoryMergeReview: ComponentType<
      ComponentProps<typeof SpendingCategoryMergeReview>
    >;
    FinancialTransactionFormFields: typeof FinancialTransactionFormFields;
    EntityPhotosSection: typeof EntityPhotosSection;
    createUnitMappingsColumn: typeof createUnitMappingsColumn;
    useInventoryPlacementAction: typeof useInventoryPlacementAction;
    useUpcAwareCreate: typeof useUpcAwareCreate;
  };
}

let installed: FeatureRegistry | undefined;

/** Called once by `features/registry.tsx`'s installer at app start. */
export function installFeatureRegistry(registry: FeatureRegistry): void {
  installed = registry;
}

export function featureRegistry(): FeatureRegistry {
  if (installed === undefined) {
    throw new Error(
      "The feature registry is not installed: the rendering route chunk must call `installFeatures()` from `~/features/registry` first (see `routes/_authenticated.tsx`).",
    );
  }
  return installed;
}

import type { ReportSlot } from "@cubby/schemas/entity-report";
import type { RunOut } from "@cubby/schemas/run";
import {
  hasImportRunReports,
  type RunPurpose,
} from "@cubby/schemas/run-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { type FunctionComponent, lazy } from "react";

import type {
  CollectionActionProps,
  CollectionActionTable,
} from "~/entity/entity-detail/collection-actions";
import type { HeaderActionTable } from "~/entity/entity-detail/detail-action-bar";
import {
  type DetailEditOverrideTable,
  RecipeEditRedirect,
} from "~/entity/entity-detail/detail-edit-overrides";
import type {
  DetailRecordOf,
  GenericDetailEntity,
} from "~/entity/entity-detail/detail-record";
import type {
  DetailSlot,
  DetailSlotComponent,
  DetailSlotTable,
} from "~/entity/entity-detail/detail-slots";
import type {
  SectionActionComponent,
  SectionActionTable,
} from "~/entity/entity-detail/section-actions";
import type { ListSlotComponent } from "~/entity/entity-list/list-slot-types";
import type { ListSlotTable } from "~/entity/entity-list/list-slots";
import { installFeatureRegistry } from "~/entity/feature-registry";
import {
  implemented,
  type PresentationCoverage,
} from "~/entity/presentation-coverage";
import { expenseDetailFields } from "~/features/expense/detail-field-renderers";
import { financialTransactionDetailFields } from "~/features/finance/detail-field-renderers";
import {
  SourceAliasesField,
  SourceRefsField,
} from "~/features/finance/financial-form-fields";
import { FinancialTransactionFormFields } from "~/features/finance/financial-transaction-form";
import { financialTransactionListRenderers } from "~/features/finance/list-renderers";
import { EntityPhotosSection } from "~/features/image/entity-photos-section";
import { discardInventoryActionDefinition } from "~/features/inventory/discard-inventory-action";
import { inventoryLocationEntityActionDefinitions } from "~/features/inventory/inventory-location-entity-actions";
import { useInventoryPlacementAction } from "~/features/inventory/inventory-placement-suggestion";
import { locationListRenderers } from "~/features/location/list-renderers";
import { addToInventoryActionDefinition } from "~/features/product/add-to-inventory-action";
import { ProductDiscardDialog } from "~/features/product/product-discard-dialog";
import {
  ProductExternalIdsField,
  ProductLabelNutritionField,
  productMedia,
  ProductTagsField,
  ProductUnitMappingsField,
  ProductUpcField,
  ProductUsdaFoodField,
} from "~/features/product/product-editor-fields";
import { useUpcAwareCreate } from "~/features/product/use-upc-aware-create";
import { purchaseListRenderers } from "~/features/purchase/list-renderers";
import { recipeEntityActionDefinitions } from "~/features/recipe/recipe-entity-actions";
import {
  createProjectFromTasksActionDefinition,
  markExpensePurchasedActionDefinition,
} from "~/features/task/tracker-entity-actions";
import { createUnitMappingsColumn } from "~/features/units/unit-mappings-column";

/*
 * The one composition point between `entity/`'s extension points and the
 * features that fill them. `entity/` declares each table's type and lookup;
 * this module imports every feature and builds the contents. Fills that are a
 * whole section, header, verb or dialog stay `lazy(() => import(...))` so each
 * route chunk carries only what its own entity declares. Code-split entry
 * points call `installFeatures()` (see `entity/feature-registry.ts`).
 */

/** `lazy` wants a default export; expose one named export as it. */
const named = <M, K extends keyof M>(
  module: Promise<M>,
  name: K,
): Promise<{ default: M[K] }> => module.then((m) => ({ default: m[name] }));

/** The Run slots that are nothing but their server-composed report. */
type RunReportSlotId =
  keyof typeof import("~/features/run/slots").runReportSlots;

const isImportRun = (run: { purpose: RunPurpose }) =>
  hasImportRunReports(run.purpose);

const isLiveRun = (run: { status: string }) =>
  ACTIVE_RUN_STATUSES.some((status) => status === run.status);

/** A Run slot that is nothing but its server-composed report (`run.<slot>` in `reportSlots`). */
const runReportSlot = (
  report: RunReportSlotId,
  applies?: (run: RunOut) => boolean,
): PresentationCoverage<DetailSlot<"run">> =>
  slot(
    () =>
      import("~/features/run/slots").then((m) => ({
        default: m.runReportSlots[report],
      })),
    applies,
  );

type SlotModule<T> = Promise<{ default: T }>;
const slot = <E extends GenericDetailEntity>(
  load: () => SlotModule<DetailSlotComponent<E>>,
  applies?: (record: DetailRecordOf<E>) => boolean,
): PresentationCoverage<DetailSlot<E>> =>
  implemented(
    applies ? { component: lazy(load), applies } : { component: lazy(load) },
  );

/** Reports share one renderer on every entity; only the declared slot changes. */
const reportSlot = <E extends GenericDetailEntity>(report: ReportSlot) =>
  slot<E>(() =>
    import("~/entity/entity-detail/report-slot").then(
      ({ EntityReportSlot }) => ({
        default: ({ record }: { record: DetailRecordOf<E> }) => (
          <EntityReportSlot slot={report} id={record.id} record={record} />
        ),
      }),
    ),
  );

/** `DetailSlotTable`: every declared detail slot's lazy fill. */
const detailSlots = {
  email: {
    review: slot<"email">(() =>
      named(import("~/entity/entity-detail/email-review"), "EmailReview"),
    ),
  },
  imageJob: { attempts: reportSlot<"imageJob">("imageJob.attempts") },
  product: {
    ownership: slot(() =>
      named(
        import("~/features/product/product-runs"),
        "ProductOwnershipEvidence",
      ),
    ),
    nutrition: slot(() =>
      named(import("~/features/product/slots"), "ProductNutrition"),
    ),
    "unit-mappings": slot(() =>
      named(import("~/features/product/slots"), "ProductUnitMappings"),
    ),
    "fits-with": slot(() =>
      named(import("~/features/product/slots"), "ProductFitsWith"),
    ),
    cookbooks: slot(
      () => named(import("~/features/product/slots"), "ProductCookbooks"),
      (product) => product.cookbooks.length > 0,
    ),
    "recipe-appearances": slot(
      () =>
        named(import("~/features/product/slots"), "ProductRecipeAppearances"),
      (product) => product.ingredient !== null,
    ),
    labels: slot(() =>
      named(import("~/features/product/slots"), "ProductLabels"),
    ),
    runs: slot(() =>
      named(import("~/features/product/product-runs"), "ProductRuns"),
    ),
  },
  recipe: {
    workflow: slot(() =>
      named(import("~/features/recipe/slots"), "RecipeWorkflow"),
    ),
  },
  ingredient: {
    "nutrition-product": slot(() =>
      named(
        import("~/features/ingredient/slots"),
        "IngredientNutritionProduct",
      ),
    ),
    "recipe-usages": slot(() =>
      named(import("~/features/ingredient/slots"), "IngredientRecipeUsages"),
    ),
  },
  cookbook: {
    toc: slot(() =>
      named(import("~/features/cookbook/slots"), "CookbookContents"),
    ),
    "import-progress": slot(() =>
      named(import("~/features/cookbook/slots"), "CookbookImportProgress"),
    ),
  },
  location: {
    "contents-valuation": slot(() =>
      named(import("~/features/location/slots"), "LocationContentsValuation"),
    ),
    "ai-description": slot(() =>
      named(import("~/features/location/slots"), "LocationAiDescription"),
    ),
  },
  meal: {
    composition: slot(() =>
      named(import("~/features/meal/slots"), "MealComposition"),
    ),
    nutrition: slot(() =>
      named(import("~/features/meal/slots"), "MealNutrition"),
    ),
  },
  project: {
    schedule: slot(() =>
      named(import("~/features/project/slots"), "ProjectSchedule"),
    ),
    budget: slot(() =>
      named(import("~/features/project/slots"), "ProjectBudget"),
    ),
    contribution: slot(() =>
      named(import("~/features/project/slots"), "ProjectContribution"),
    ),
    analytics: slot(() =>
      named(import("~/features/project/slots"), "ProjectAnalytics"),
    ),
  },
  productCategory: {
    "spending-classification": slot(() =>
      named(
        import("~/features/finance/spending-classification-review"),
        "ProductCategoryClassification",
      ),
    ),
  },
  vendor: {
    "spending-classification": slot(() =>
      named(
        import("~/features/finance/spending-classification-review"),
        "VendorClassification",
      ),
    ),
  },
  purchase: {
    runs: slot(() => named(import("~/features/purchase/slots"), "Runs")),
    "project-allocation": slot(() =>
      named(
        import("~/features/purchase/project-allocation-table"),
        "PurchaseProjectAllocation",
      ),
    ),
    receiving: slot(() =>
      named(
        import("~/features/purchase/receive-purchase-section"),
        "PurchaseReceiving",
      ),
    ),
    reconciliation: slot(() =>
      named(import("~/features/purchase/slots"), "PurchaseReconciliation"),
    ),
    "financial-settlement": slot(() =>
      named(
        import("~/features/purchase/financial-settlement-body"),
        "PurchaseFinancialSettlement",
      ),
    ),
  },
  expense: {
    settlement: slot(() =>
      named(
        import("~/features/expense/expense-settlement-body"),
        "ExpenseSettlement",
      ),
    ),
  },
  run: {
    // Progress, usage and changes are server-composed report slots; `runReportSlot` is their one
    // component (`features/run/slots.tsx`).
    "live-progress": runReportSlot("live-progress"),
    "import-controls": slot(
      () =>
        named(
          import("~/features/purchase/purchase-import-run-detail"),
          "RunImportControls",
        ),
      isImportRun,
    ),
    "import-stats": runReportSlot("import-stats", isImportRun),
    "import-progress-live": runReportSlot(
      "import-progress-live",
      (run) => isImportRun(run) && isLiveRun(run),
    ),
    "import-agent-live": slot(
      () =>
        named(
          import("~/features/purchase/purchase-import-run-detail"),
          "RunImportAgentActive",
        ),
      isImportRun,
    ),
    "import-purchases": runReportSlot("import-purchases", isImportRun),
    "import-approvals": runReportSlot("import-approvals", isImportRun),
    "import-findings": runReportSlot("import-findings", isImportRun),
    "import-targets": runReportSlot("import-targets", isImportRun),
    "import-prepared-orders": runReportSlot(
      "import-prepared-orders",
      isImportRun,
    ),
    "import-progress-stopped": runReportSlot(
      "import-progress-stopped",
      (run) => isImportRun(run) && !isLiveRun(run),
    ),
    "import-agent-stopped": slot(
      () =>
        named(
          import("~/features/purchase/purchase-import-run-detail"),
          "RunImportAgentStopped",
        ),
      isImportRun,
    ),
    "import-timeline": runReportSlot("import-timeline"),
    "import-debug-log": runReportSlot("import-debug-log"),
    suggestions: slot(
      () => named(import("~/features/run/slots"), "RunSuggestions"),
      (run) => run.purpose === "suggestion_sweep",
    ),
    "photo-batch": slot(
      () =>
        named(
          import("~/features/purchase/purchase-import-run-detail"),
          "RunPhotoBatch",
        ),
      (run) => run.purpose === "photo_inventory",
    ),
    "ai-usage": runReportSlot("ai-usage"),
    changes: slot(() => named(import("~/features/run/slots"), "RunChanges")),
  },
  image: {
    associations: slot(() =>
      named(import("~/features/image/slots"), "ImageAssociations"),
    ),
  },
} satisfies DetailSlotTable;

/**
 * Binds one entity's slot module to its slot ids. Each fill is lazy so the
 * generic list route's chunk carries no slot view — the meal calendar,
 * project dashboards and task board load only when their view is selected.
 */
const slotsFrom =
  <Id extends string>(
    load: () => Promise<Readonly<Record<Id, ListSlotComponent>>>,
  ) =>
  (id: Id): PresentationCoverage<ListSlotComponent> =>
    implemented(
      lazy<ListSlotComponent>(() =>
        load().then((slots) => ({ default: slots[id] })),
      ),
    );

const emailList = slotsFrom(() =>
  import("~/features/email/list-slots").then((m) => m.emailListSlots),
);
const expenseList = slotsFrom(() =>
  import("~/features/expense/list-slots").then((m) => m.expenseListSlots),
);
const locationList = slotsFrom(() =>
  import("~/features/location/list-slots").then((m) => m.locationListSlots),
);
const mealList = slotsFrom(() =>
  import("~/features/meal/list-slots").then((m) => m.mealListSlots),
);
const plantingList = slotsFrom(() =>
  import("~/features/planting/list-slots").then((m) => m.plantingListSlots),
);
const productCategoryList = slotsFrom(() =>
  import("~/features/product-category/list-slots").then(
    (m) => m.productCategoryListSlots,
  ),
);
const projectList = slotsFrom(() =>
  import("~/features/project/list-slots").then((m) => m.projectListSlots),
);
const taskList = slotsFrom(() =>
  import("~/features/task/list-slots").then((m) => m.taskListSlots),
);

/** `ListSlotTable`: every declared list view's lazy fill. */
const listSlots = {
  email: { accuracy: emailList("accuracy") },
  expense: { analytics: expenseList("analytics") },
  location: {
    gallery: locationList("gallery"),
    visualizations: locationList("visualizations"),
  },
  meal: { calendar: mealList("calendar"), nutrition: mealList("nutrition") },
  planting: { schedule: plantingList("schedule") },
  productCategory: { hierarchy: productCategoryList("hierarchy") },
  project: {
    overview: projectList("overview"),
    schedule: projectList("schedule"),
    analytics: projectList("analytics"),
  },
  task: { agenda: taskList("agenda"), board: taskList("board") },
} satisfies ListSlotTable;

const headerAction = <E extends GenericDetailEntity>(
  load: () => Promise<{ default: DetailSlotComponent<E> }>,
) => lazy(load);

/** `HeaderActionTable`: each entity's own header controls. */
const headerActions: HeaderActionTable = {
  purchase: headerAction<"purchase">(() =>
    named(
      import("~/entity/entity-detail/report-slot"),
      "PurchaseDetailActions",
    ),
  ),
  expense: headerAction<"expense">(() =>
    named(import("~/entity/entity-detail/report-slot"), "ExpenseDetailActions"),
  ),
  product: headerAction<"product">(() =>
    named(import("~/features/product/product-runs"), "ProductDetailActions"),
  ),
  image: headerAction<"image">(() =>
    named(
      import("~/features/image/image-processing-panel"),
      "ImageDetailActions",
    ),
  ),
  run: headerAction<"run">(() =>
    named(import("~/features/run/detail-actions"), "RunDetailActions"),
  ),
  inventory: headerAction<"inventory">(() =>
    named(
      import("~/entity/display/detail-field-renderers/inventory-expense"),
      "InventoryRecordExpenseAction",
    ),
  ),
  recipe: headerAction<"recipe">(() =>
    named(import("~/features/recipe/slots"), "RecipeActions"),
  ),
  cookbook: headerAction<"cookbook">(() =>
    named(import("~/features/cookbook/slots"), "CookbookActions"),
  ),
  meal: headerAction<"meal">(() =>
    named(import("~/features/meal/slots"), "MealActions"),
  ),
};

const sectionAction = <E extends GenericDetailEntity>(
  load: () => Promise<{ default: SectionActionComponent<E> }>,
) => lazy(load);

/** `SectionActionTable`: the web run of every declared section verb. */
const sectionActions = {
  purchase: {
    matchStatement: sectionAction(() =>
      named(
        import("~/features/purchase/section-actions"),
        "MatchStatementAction",
      ),
    ),
    linkExpenses: sectionAction(() =>
      named(
        import("~/features/purchase/section-actions"),
        "LinkExpensesAction",
      ),
    ),
    linkProducts: sectionAction(() =>
      named(
        import("~/features/purchase/section-actions"),
        "LinkProductsAction",
      ),
    ),
  },
  expense: {
    splitExpense: sectionAction(() =>
      named(import("~/features/expense/section-actions"), "SplitExpenseAction"),
    ),
    receiveExpense: sectionAction(() =>
      named(
        import("~/features/expense/section-actions"),
        "ReceiveExpenseAction",
      ),
    ),
  },
} satisfies SectionActionTable;

const collectionAction = <E extends GenericDetailEntity>(
  load: () => Promise<{
    default: FunctionComponent<CollectionActionProps<E>>;
  }>,
) => lazy(load);

/** `CollectionActionTable`: every report `records` block action. */
const collectionActions = {
  analyzeLocation: collectionAction<"location">(() =>
    named(import("~/features/location/slots"), "AnalyzeLocationAction"),
  ),
  attachImage: collectionAction<"image">(() =>
    named(import("~/features/image/slots"), "AttachImageAction"),
  ),
  reviewLabelNutrition: collectionAction<"product">(() =>
    named(import("~/features/product/slots"), "ReviewLabelNutritionAction"),
  ),
} satisfies CollectionActionTable;

/** `DetailEditOverrideTable`: entities whose Edit does not open the generic dialog. */
const detailEditOverrides = {
  recipe: RecipeEditRedirect,
  cookbook: lazy(() =>
    named(
      import("~/features/cookbook/cookbook-edit-dialog"),
      "CookbookEditDialog",
    ),
  ),
  image: lazy(() =>
    named(import("~/features/image/image-edit-dialog"), "ImageEditDialog"),
  ),
} satisfies DetailEditOverrideTable;

const SpendingCategoryMergeReview = lazy(() =>
  named(
    import("~/features/finance/spending-classification-review"),
    "SpendingCategoryMergeReview",
  ),
);

/** Installs every feature fill; idempotent, so each entry point may call it. */
let featuresInstalled = false;

export function installFeatures(): void {
  if (featuresInstalled) return;
  featuresInstalled = true;
  installFeatureRegistry({
    detailSlots,
    listSlots,
    headerActions,
    sectionActions,
    collectionActions,
    detailEditOverrides,
    detailFieldRenderers: {
      expense: expenseDetailFields,
      financialTransaction: financialTransactionDetailFields,
    },
    listRenderers: {
      financialTransaction: financialTransactionListRenderers,
      location: locationListRenderers,
      purchase: purchaseListRenderers,
    },
    controlRenderers: {
      "unit-mappings": ProductUnitMappingsField,
      "label-nutrition": ProductLabelNutritionField,
      "external-ids": ProductExternalIdsField,
      "upc-lookup": ProductUpcField,
      "usda-food": ProductUsdaFoodField,
      "product-tags": ProductTagsField,
      // `SourceAliasesField`/`SourceRefsField` already hardcode their own
      // `name` (`sourceAliases`/`sourceRefs`), the only field key either
      // renderer is ever declared against — no need to thread `field.key`.
      "source-aliases": ({ form }) => <SourceAliasesField form={form} />,
      "source-refs": ({ form }) => <SourceRefsField form={form} />,
    },
    productMedia,
    entityActions: {
      addToInventory: addToInventoryActionDefinition,
      discardInventory: discardInventoryActionDefinition,
      recipe: recipeEntityActionDefinitions,
      inventoryLocation: inventoryLocationEntityActionDefinitions,
      markExpensePurchased: markExpensePurchasedActionDefinition,
      createProjectFromTasks: createProjectFromTasksActionDefinition,
    },
    components: {
      ProductDiscardDialog,
      SpendingCategoryMergeReview,
      FinancialTransactionFormFields,
      EntityPhotosSection,
      createUnitMappingsColumn,
      useInventoryPlacementAction,
      useUpcAwareCreate,
    },
  });
}

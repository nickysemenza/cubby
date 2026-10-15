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
      import("~/entity/entity-detail/email-review").then((m) => ({
        default: m.EmailReview,
      })),
    ),
  },
  imageJob: { attempts: reportSlot<"imageJob">("imageJob.attempts") },
  product: {
    ownership: slot(() =>
      import("~/features/product/product-runs").then((m) => ({
        default: m.ProductOwnershipEvidence,
      })),
    ),
    nutrition: slot(() =>
      import("~/features/product/slots").then((m) => ({
        default: m.ProductNutrition,
      })),
    ),
    "unit-mappings": slot(() =>
      import("~/features/product/slots").then((m) => ({
        default: m.ProductUnitMappings,
      })),
    ),
    "fits-with": slot(() =>
      import("~/features/product/slots").then((m) => ({
        default: m.ProductFitsWith,
      })),
    ),
    cookbooks: slot(
      () =>
        import("~/features/product/slots").then((m) => ({
          default: m.ProductCookbooks,
        })),
      (product) => product.cookbooks.length > 0,
    ),
    "recipe-appearances": slot(
      () =>
        import("~/features/product/slots").then((m) => ({
          default: m.ProductRecipeAppearances,
        })),
      (product) => product.ingredient !== null,
    ),
    labels: slot(() =>
      import("~/features/product/slots").then((m) => ({
        default: m.ProductLabels,
      })),
    ),
    runs: slot(() =>
      import("~/features/product/product-runs").then((m) => ({
        default: m.ProductRuns,
      })),
    ),
  },
  recipe: {
    workflow: slot(() =>
      import("~/features/recipe/slots").then((m) => ({
        default: m.RecipeWorkflow,
      })),
    ),
  },
  ingredient: {
    "nutrition-product": slot(() =>
      import("~/features/ingredient/slots").then((m) => ({
        default: m.IngredientNutritionProduct,
      })),
    ),
    "recipe-usages": slot(() =>
      import("~/features/ingredient/slots").then((m) => ({
        default: m.IngredientRecipeUsages,
      })),
    ),
  },
  cookbook: {
    toc: slot(() =>
      import("~/features/cookbook/slots").then((m) => ({
        default: m.CookbookContents,
      })),
    ),
    "import-progress": slot(() =>
      import("~/features/cookbook/slots").then((m) => ({
        default: m.CookbookImportProgress,
      })),
    ),
  },
  location: {
    "contents-valuation": slot(() =>
      import("~/features/location/slots").then((m) => ({
        default: m.LocationContentsValuation,
      })),
    ),
    "ai-description": slot(() =>
      import("~/features/location/slots").then((m) => ({
        default: m.LocationAiDescription,
      })),
    ),
  },
  meal: {
    composition: slot(() =>
      import("~/features/meal/slots").then((m) => ({
        default: m.MealComposition,
      })),
    ),
    nutrition: slot(() =>
      import("~/features/meal/slots").then((m) => ({
        default: m.MealNutrition,
      })),
    ),
  },
  project: {
    schedule: slot(() =>
      import("~/features/project/slots").then((m) => ({
        default: m.ProjectSchedule,
      })),
    ),
    budget: slot(() =>
      import("~/features/project/slots").then((m) => ({
        default: m.ProjectBudget,
      })),
    ),
    contribution: slot(() =>
      import("~/features/project/slots").then((m) => ({
        default: m.ProjectContribution,
      })),
    ),
    analytics: slot(() =>
      import("~/features/project/slots").then((m) => ({
        default: m.ProjectAnalytics,
      })),
    ),
  },
  productCategory: {
    "spending-classification": slot(() =>
      import("~/features/finance/spending-classification-review").then((m) => ({
        default: m.ProductCategoryClassification,
      })),
    ),
  },
  vendor: {
    "spending-classification": slot(() =>
      import("~/features/finance/spending-classification-review").then((m) => ({
        default: m.VendorClassification,
      })),
    ),
  },
  purchase: {
    runs: slot(() =>
      import("~/features/purchase/slots").then((m) => ({
        default: m.Runs,
      })),
    ),
    "project-allocation": slot(() =>
      import("~/features/purchase/project-allocation-table").then((m) => ({
        default: m.PurchaseProjectAllocation,
      })),
    ),
    receiving: slot(() =>
      import("~/features/purchase/receive-purchase-section").then((m) => ({
        default: m.PurchaseReceiving,
      })),
    ),
    reconciliation: slot(() =>
      import("~/features/purchase/slots").then((m) => ({
        default: m.PurchaseReconciliation,
      })),
    ),
    "financial-settlement": slot(() =>
      import("~/features/purchase/financial-settlement-body").then((m) => ({
        default: m.PurchaseFinancialSettlement,
      })),
    ),
  },
  expense: {
    settlement: slot(() =>
      import("~/features/expense/expense-settlement-body").then((m) => ({
        default: m.ExpenseSettlement,
      })),
    ),
  },
  run: {
    // Progress, usage and changes are server-composed report slots; `runReportSlot` is their one
    // component (`features/run/slots.tsx`).
    "live-progress": runReportSlot("live-progress"),
    "import-controls": slot(
      () =>
        import("~/features/purchase/purchase-import-run-detail").then((m) => ({
          default: m.RunImportControls,
        })),
      isImportRun,
    ),
    "import-stats": runReportSlot("import-stats", isImportRun),
    "import-progress-live": runReportSlot(
      "import-progress-live",
      (run) => isImportRun(run) && isLiveRun(run),
    ),
    "import-agent-live": slot(
      () =>
        import("~/features/purchase/purchase-import-run-detail").then((m) => ({
          default: m.RunImportAgentActive,
        })),
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
        import("~/features/purchase/purchase-import-run-detail").then((m) => ({
          default: m.RunImportAgentStopped,
        })),
      isImportRun,
    ),
    "import-timeline": runReportSlot("import-timeline"),
    "import-debug-log": runReportSlot("import-debug-log"),
    suggestions: slot(
      () =>
        import("~/features/run/slots").then((m) => ({
          default: m.RunSuggestions,
        })),
      (run) => run.purpose === "suggestion_sweep",
    ),
    "photo-batch": slot(
      () =>
        import("~/features/purchase/purchase-import-run-detail").then((m) => ({
          default: m.RunPhotoBatch,
        })),
      (run) => run.purpose === "photo_inventory",
    ),
    "ai-usage": runReportSlot("ai-usage"),
    changes: slot(() =>
      import("~/features/run/slots").then((m) => ({
        default: m.RunChanges,
      })),
    ),
  },
  image: {
    associations: slot(() =>
      import("~/features/image/slots").then((m) => ({
        default: m.ImageAssociations,
      })),
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
    import("~/entity/entity-detail/report-slot").then((m) => ({
      default: m.PurchaseDetailActions,
    })),
  ),
  expense: headerAction<"expense">(() =>
    import("~/entity/entity-detail/report-slot").then((m) => ({
      default: m.ExpenseDetailActions,
    })),
  ),
  product: headerAction<"product">(() =>
    import("~/features/product/product-runs").then((m) => ({
      default: m.ProductDetailActions,
    })),
  ),
  image: headerAction<"image">(() =>
    import("~/features/image/image-processing-panel").then((m) => ({
      default: m.ImageDetailActions,
    })),
  ),
  run: headerAction<"run">(() =>
    import("~/features/run/detail-actions").then((m) => ({
      default: m.RunDetailActions,
    })),
  ),
  inventory: headerAction<"inventory">(() =>
    import("~/entity/display/detail-field-renderers/inventory-expense").then(
      (m) => ({
        default: m.InventoryRecordExpenseAction,
      }),
    ),
  ),
  recipe: headerAction<"recipe">(() =>
    import("~/features/recipe/slots").then((m) => ({
      default: m.RecipeActions,
    })),
  ),
  cookbook: headerAction<"cookbook">(() =>
    import("~/features/cookbook/slots").then((m) => ({
      default: m.CookbookActions,
    })),
  ),
  meal: headerAction<"meal">(() =>
    import("~/features/meal/slots").then((m) => ({ default: m.MealActions })),
  ),
};

const sectionAction = <E extends GenericDetailEntity>(
  load: () => Promise<{ default: SectionActionComponent<E> }>,
) => lazy(load);

/** `SectionActionTable`: the web run of every declared section verb. */
const sectionActions = {
  purchase: {
    matchStatement: sectionAction(() =>
      import("~/features/purchase/section-actions").then((m) => ({
        default: m.MatchStatementAction,
      })),
    ),
    linkExpenses: sectionAction(() =>
      import("~/features/purchase/section-actions").then((m) => ({
        default: m.LinkExpensesAction,
      })),
    ),
    linkProducts: sectionAction(() =>
      import("~/features/purchase/section-actions").then((m) => ({
        default: m.LinkProductsAction,
      })),
    ),
  },
  expense: {
    splitExpense: sectionAction(() =>
      import("~/features/expense/section-actions").then((m) => ({
        default: m.SplitExpenseAction,
      })),
    ),
    receiveExpense: sectionAction(() =>
      import("~/features/expense/section-actions").then((m) => ({
        default: m.ReceiveExpenseAction,
      })),
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
    import("~/features/location/slots").then((m) => ({
      default: m.AnalyzeLocationAction,
    })),
  ),
  attachImage: collectionAction<"image">(() =>
    import("~/features/image/slots").then((m) => ({
      default: m.AttachImageAction,
    })),
  ),
  reviewLabelNutrition: collectionAction<"product">(() =>
    import("~/features/product/slots").then((m) => ({
      default: m.ReviewLabelNutritionAction,
    })),
  ),
} satisfies CollectionActionTable;

/** `DetailEditOverrideTable`: entities whose Edit does not open the generic dialog. */
const detailEditOverrides = {
  recipe: RecipeEditRedirect,
  cookbook: lazy(() =>
    import("~/features/cookbook/cookbook-edit-dialog").then((module) => ({
      default: module.CookbookEditDialog,
    })),
  ),
  image: lazy(() =>
    import("~/features/image/image-edit-dialog").then((module) => ({
      default: module.ImageEditDialog,
    })),
  ),
} satisfies DetailEditOverrideTable;

const SpendingCategoryMergeReview = lazy(() =>
  import("~/features/finance/spending-classification-review").then((m) => ({
    default: m.SpendingCategoryMergeReview,
  })),
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

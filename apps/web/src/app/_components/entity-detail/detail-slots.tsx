import type { DetailSlotId } from "@cubby/schemas/entity-manifest";
import type { ImportRunPurpose } from "@cubby/schemas/import-run-fields";
import { type FunctionComponent, lazy, type LazyExoticComponent } from "react";

import {
  implemented,
  type PresentationCoverage,
} from "~/entities/presentation-coverage";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

/** A slot renders one declared section body against the loaded record. */
export type DetailSlotComponent<E extends GenericDetailEntity> =
  FunctionComponent<{ record: DetailRecordOf<E> }>;

export interface DetailSlot<E extends GenericDetailEntity> {
  component: LazyExoticComponent<DetailSlotComponent<E>>;
  /**
   * Whether the section renders for this record at all — a garden section
   * on a product that grows nothing has no header to show. Synchronous on
   * purpose: it decides the section ledger before anything loads.
   */
  applies?(record: DetailRecordOf<E>): boolean;
}

/**
 * Run purposes the purchase agent drives: they carry a vendor, orders, an
 * agent transcript and evidence. AI-only runs (`ai_suggest`, `ai_action`,
 * `background`) and photo batches do not.
 */
const IMPORT_WORKFLOW_PURPOSES: ReadonlySet<ImportRunPurpose> = new Set([
  "account_sync",
  "purchase_validation",
  "product_enrichment",
  "file_import",
  "legacy",
]);

type SlotModule<T> = Promise<{ default: T }>;
const slot = <E extends GenericDetailEntity>(
  load: () => SlotModule<DetailSlotComponent<E>>,
  applies?: (record: DetailRecordOf<E>) => boolean,
): PresentationCoverage<DetailSlot<E>> =>
  implemented(
    applies ? { component: lazy(load), applies } : { component: lazy(load) },
  );

/**
 * The web fills for every `kind: "slot"` section the declarations name.
 * Keyed by `DetailSlotId<E>`, so a slot id the declaration drops (or
 * misspells) fails to compile here. Each fill is lazy: a detail route's
 * chunk carries only the slots its own entity declares.
 */
export const detailSlots = {
  ledgerParty: {
    wardrobe: slot(
      () =>
        import("~/app/collections/wardrobe-link").then((m) => ({
          default: m.WardrobeLink,
        })),
      (record) => record.kind === "member" || record.kind === "guest",
    ),
  },
  product: {
    nutrition: slot(() =>
      import("~/app/products/slots").then((m) => ({
        default: m.ProductNutrition,
      })),
    ),
    "unit-mappings": slot(() =>
      import("~/app/products/slots").then((m) => ({
        default: m.ProductUnitMappings,
      })),
    ),
    "fits-with": slot(() =>
      import("~/app/products/slots").then((m) => ({
        default: m.ProductFitsWith,
      })),
    ),
    cookbooks: slot(
      () =>
        import("~/app/products/slots").then((m) => ({
          default: m.ProductCookbooks,
        })),
      (product) => product.cookbooks.length > 0,
    ),
    "recipe-appearances": slot(
      () =>
        import("~/app/products/slots").then((m) => ({
          default: m.ProductRecipeAppearances,
        })),
      (product) => product.ingredient !== null,
    ),
    labels: slot(() =>
      import("~/app/products/slots").then((m) => ({
        default: m.ProductLabels,
      })),
    ),
    "import-runs": slot(() =>
      import("~/app/products/product-import-runs").then((m) => ({
        default: m.ProductImportRuns,
      })),
    ),
  },
  recipe: {
    workflow: slot(() =>
      import("~/app/recipes/slots").then((m) => ({
        default: m.RecipeWorkflow,
      })),
    ),
  },
  ingredient: {
    "nutrition-product": slot(() =>
      import("~/app/ingredients/slots").then((m) => ({
        default: m.IngredientNutritionProduct,
      })),
    ),
  },
  cookbook: {
    toc: slot(() =>
      import("~/app/cookbooks/slots").then((m) => ({
        default: m.CookbookContents,
      })),
    ),
    "import-progress": slot(() =>
      import("~/app/cookbooks/slots").then((m) => ({
        default: m.CookbookImportProgress,
      })),
    ),
  },
  location: {
    "contents-valuation": slot(() =>
      import("~/app/locations/slots").then((m) => ({
        default: m.LocationContentsValuation,
      })),
    ),
    "ai-description": slot(() =>
      import("~/app/locations/slots").then((m) => ({
        default: m.LocationAiDescription,
      })),
    ),
  },
  meal: {
    composition: slot(() =>
      import("~/app/meals/slots").then((m) => ({
        default: m.MealComposition,
      })),
    ),
    nutrition: slot(() =>
      import("~/app/meals/slots").then((m) => ({ default: m.MealNutrition })),
    ),
  },
  project: {
    schedule: slot(() =>
      import("~/app/projects/slots").then((m) => ({
        default: m.ProjectSchedule,
      })),
    ),
    budget: slot(() =>
      import("~/app/projects/slots").then((m) => ({
        default: m.ProjectBudget,
      })),
    ),
    contribution: slot(() =>
      import("~/app/projects/slots").then((m) => ({
        default: m.ProjectContribution,
      })),
    ),
    analytics: slot(() =>
      import("~/app/projects/slots").then((m) => ({
        default: m.ProjectAnalytics,
      })),
    ),
  },
  purchase: {
    "import-runs": slot(() =>
      import("~/app/purchases/slots").then((m) => ({
        default: m.ImportRuns,
      })),
    ),
    "project-allocation": slot(() =>
      import("~/app/purchases/slots").then((m) => ({
        default: m.PurchaseProjectAllocation,
      })),
    ),
    reconciliation: slot(() =>
      import("~/app/purchases/slots").then((m) => ({
        default: m.PurchaseReconciliation,
      })),
    ),
    "financial-settlement": slot(() =>
      import("~/app/purchases/slots").then((m) => ({
        default: m.PurchaseFinancialSettlement,
      })),
    ),
  },
  expense: {
    settlement: slot(() =>
      import("~/app/expenses/slots").then((m) => ({
        default: m.ExpenseSettlement,
      })),
    ),
  },
  importRun: {
    "import-workflow": slot(
      () =>
        import("~/app/purchases/purchase-import-run-detail").then((m) => ({
          default: m.RunImportWorkflow,
        })),
      (run) => IMPORT_WORKFLOW_PURPOSES.has(run.purpose),
    ),
    "photo-batch": slot(
      () =>
        import("~/app/purchases/purchase-import-run-detail").then((m) => ({
          default: m.RunPhotoBatch,
        })),
      (run) => run.purpose === "photo_inventory",
    ),
    "ai-usage": slot(() =>
      import("~/app/import-runs/slots").then((m) => ({
        default: m.RunAiUsage,
      })),
    ),
    changes: slot(() =>
      import("~/app/import-runs/slots").then((m) => ({
        default: m.RunChanges,
      })),
    ),
  },
  image: {
    associations: slot(() =>
      import("~/app/images/slots").then((m) => ({
        default: m.ImageAssociations,
      })),
    ),
  },
} satisfies {
  [
    E in GenericDetailEntity as DetailSlotId<E> extends never ? never : E
  ]: Record<DetailSlotId<E>, PresentationCoverage<DetailSlot<E>>>;
};

/** The slots for one entity, read through the erased map the page walks. */
export const detailSlotsFor = (
  entity: GenericDetailEntity,
): Readonly<Record<string, DetailSlot<never>>> | undefined => {
  if (!Object.hasOwn(detailSlots, entity)) return undefined;
  // SAFETY: `hasOwn` proves `entity` is one of the registry's own keys. The
  // public erased map is consumed only with this same entity's record.
  const coverage = detailSlots[entity as keyof typeof detailSlots] as Readonly<
    Record<string, PresentationCoverage<DetailSlot<never>>>
  >;
  return Object.fromEntries(
    Object.entries(coverage).map(([id, disposition]) => {
      if (disposition.kind !== "implemented") {
        throw new Error(`Web detail slot ${entity}.${id} is not implemented`);
      }
      return [id, disposition.implementation];
    }),
  );
};

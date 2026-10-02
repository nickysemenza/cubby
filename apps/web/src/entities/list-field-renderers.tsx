import type { ActivityRun } from "@cubby/schemas/activity";
import { dataQuality } from "@cubby/schemas/data-quality";
import type { DataQuality } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import type { ListRendererId } from "@cubby/schemas/entity-manifest";
import type { ImageWithEntity } from "@cubby/schemas/image";
import type { CookbookSummary } from "@cubby/schemas/recipe";
import type { SpendingCategorySummary } from "@cubby/schemas/spending-classification";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { z } from "zod";

import { createImageColumn } from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  type CubbyColumnCollection,
  type CubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import {
  RecipeSourceLink,
  sourceLabel,
} from "~/app/_components/recipe/recipe-source";
import { NoneValue } from "~/components/ui/none-value";
import type { ListEntity } from "~/entities/generated/entity-lists.gen";

import { DataQualityValue } from "./data-quality-value";
import { SpendingCategorySummaryValue } from "./detail-field-renderers/spending-category-summary";
import type { ListRenderer, ListRowOf } from "./list-renderer-types";
import { financialTransactionListRenderers } from "./list-renderers/finance";
import { locationListRenderers } from "./list-renderers/location";
import { mealListRenderers } from "./list-renderers/meal";
import { productListRenderers } from "./list-renderers/product";
import { purchaseListRenderers } from "./list-renderers/purchase";
import { recipeListRenderers } from "./list-renderers/recipe";
import {
  implemented,
  type PresentationCoverage,
} from "./presentation-coverage";

/**
 * Entities outside the kernel list roster whose index still builds columns
 * from the manifest through a client-mode override (`list-columns/*.tsx`),
 * keyed to the row type that override pages. Image has no kernel list
 * contract (`route.list: null`) but still runs through the generic list
 * page via its own override source (`entities/list-columns/image.tsx`), so
 * it needs a coverage entry here the same way cookbook does.
 */
type ClientListRows = {
  cookbook: CookbookSummary;
  run: ActivityRun;
  "usda-food": FoodSummaryWithLinkedProducts;
  // `dataQuality` is optional on `ImageWithEntity` at the schema level (it's
  // a postprocessed field `imageWithRelationsToAPI`'s callers merge in, like
  // `representations`/`processingIssue`), but `imageList` — the only
  // producer this list renderer ever sees rows from — always attaches it.
  image: ImageWithEntity & { dataQuality: DataQuality };
};

type ClientListRenderer<TRow extends object> = (
  helper: CubbyColumnHelper<TRow>,
) => CubbyColumnCollection<TRow>;

// Ranges over every entity, not just `ListEntity`: a scored entity with no
// generic list read (cookbook — bespoke browser, no pagination envelope, see
// cookbook.ts) still gets the manifest's `dataQuality` list-renderer id and
// must carry a disposition here.
type ListRendererEntity = {
  [E in Entity]: ListRendererId<E> extends never ? never : E;
}[Entity];

type EntityListRendererCoverage<E extends ListRendererEntity> = Readonly<
  Record<
    ListRendererId<E>,
    E extends ListEntity
      ? PresentationCoverage<ListRenderer<E>>
      : E extends keyof ClientListRows
        ? PresentationCoverage<ClientListRenderer<ClientListRows[E]>>
        : PresentationCoverage<never>
  >
>;

const recipeSourceRenderer: ListRenderer<"recipe"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor("source", {
        id: "source",
        header: "Source",
        meta: {
          className: "w-44",
          mobile: { slot: "meta", priority: 30 },
        },
        cell: (info) => {
          const source = info.row.original.source;
          if (!sourceLabel(source)) return <NoneValue />;
          return (
            <RecipeSourceLink
              source={source}
              text="host"
              onClick={(event) => event.stopPropagation()}
            />
          );
        },
      }),
    );
  });

type ScoredRow = { dataQuality: DataQuality };

/** List entities whose rows carry a `dataQuality` (manifest `capabilities.dataQuality`). */
type ScoredListEntity = {
  [E in ListEntity]: ListRowOf<E> extends ScoredRow ? E : never;
}[ListEntity];

/**
 * The one `dataQuality` column every scored entity shares: one status pill
 * that carries the 0–100 score. Its id is also the sort field, so the
 * column header sorts by score (asc = weakest row first — the worklist).
 */
const qualityRow = z.object({ dataQuality: dataQuality.optional() });
const dataQualityRenderer = <TRow extends object>(
  helper: CubbyColumnHelper<TRow>,
  scored = true,
): CubbyColumnCollection<TRow> =>
  createCubbyColumnCollection<TRow>((add) => {
    const qualityOf = (row: TRow) => qualityRow.parse(row).dataQuality;
    add(
      helper.accessor((row) => qualityOf(row)?.status ?? "not_assessed", {
        id: "dataQuality",
        header: "Data quality",
        enableSorting: scored,
        sortDescFirst: false,
        sortFn: (left, right) => {
          const leftQuality = qualityOf(left.original);
          const rightQuality = qualityOf(right.original);
          if (!leftQuality) return rightQuality ? 1 : 0;
          if (!rightQuality) return -1;
          return leftQuality.score - rightQuality.score;
        },
        meta: {
          className: "w-32",
          mobile: { slot: "meta", priority: 0 },
        },
        cell: (info) => {
          const quality = qualityOf(info.row.original);
          return <DataQualityValue quality={quality} scored={scored} />;
        },
      }),
    );
  });

const scoredCoverage = <E extends ScoredListEntity>() => ({
  "data-quality": implemented<ListRenderer<E>>((helper) =>
    dataQualityRenderer(helper),
  ),
});

/**
 * The image entity's own thumbnail: a row IS an image, shown only once its
 * file has finished uploading (an upload in flight has nothing to render).
 */
const uploadedImageRenderer = (
  helper: CubbyColumnHelper<ClientListRows["image"]>,
): CubbyColumnCollection<ClientListRows["image"]> =>
  createCubbyColumnCollection<ClientListRows["image"]>((add) => {
    add(
      createImageColumn(helper, {
        id: "images",
        entity: "image",
        provenance: null,
        getImages: (row) => (row.status === "UPLOADED" ? [row] : []),
      }),
    );
  });

const categorySummaryRenderer = <
  TRow extends { spendingCategorySummary?: SpendingCategorySummary },
>(
  helper: CubbyColumnHelper<TRow>,
): CubbyColumnCollection<TRow> =>
  createCubbyColumnCollection<TRow>((add) => {
    add(
      helper.accessor((row) => row.spendingCategorySummary, {
        id: "spendingCategorySummary",
        header: "Expense categories",
        enableSorting: false,
        meta: { className: "w-56", mobile: { slot: "meta", priority: 35 } },
        cell: (info) => {
          const summary = info.row.original.spendingCategorySummary;
          return summary ? (
            <SpendingCategorySummaryValue summary={summary} compact />
          ) : (
            <NoneValue />
          );
        },
      }),
    );
  });

export const listRendererCoverage = {
  recipe: {
    "recipe-source": implemented(recipeSourceRenderer),
    ...scoredCoverage<"recipe">(),
    "estimate-cost": implemented(recipeListRenderers["estimate-cost"]),
    "estimate-kcal": implemented(recipeListRenderers["estimate-kcal"]),
    "total-time": implemented(recipeListRenderers["total-time"]),
  },
  product: {
    ...scoredCoverage<"product">(),
    "expected-quantity": implemented(productListRenderers["expected-quantity"]),
    "quantity-variance": implemented(productListRenderers["quantity-variance"]),
    "tag-links": implemented(productListRenderers["tag-links"]),
    "unit-price": implemented(productListRenderers["unit-price"]),
    "usda-food-link": implemented(productListRenderers["usda-food-link"]),
  },
  purchase: {
    ...scoredCoverage<"purchase">(),
    "spending-category-summary": implemented<ListRenderer<"purchase">>(
      (helper) => categorySummaryRenderer(helper),
    ),
    "vendor-cell": implemented(purchaseListRenderers["vendor-cell"]),
    "order-link": implemented(purchaseListRenderers["order-link"]),
    "expense-count": implemented(purchaseListRenderers["expense-count"]),
    "financial-settlement": implemented(
      purchaseListRenderers["financial-settlement"],
    ),
    "reconciliation-status": implemented(
      purchaseListRenderers["reconciliation-status"],
    ),
  },
  // pantry and garden entities
  ingredient: scoredCoverage<"ingredient">(),
  cookbook: {
    "data-quality": implemented<ClientListRenderer<CookbookSummary>>((helper) =>
      dataQualityRenderer(helper),
    ),
  },
  image: {
    "data-quality": implemented<ClientListRenderer<ClientListRows["image"]>>(
      (helper) => dataQualityRenderer(helper),
    ),
    "uploaded-image": implemented<ClientListRenderer<ClientListRows["image"]>>(
      (helper) => uploadedImageRenderer(helper),
    ),
  },
  location: {
    ...scoredCoverage<"location">(),
    "product-link": implemented(locationListRenderers["product-link"]),
    "valuation-summary": implemented(
      locationListRenderers["valuation-summary"],
    ),
  },
  inventory: scoredCoverage<"inventory">(),
  meal: {
    ...scoredCoverage<"meal">(),
    "recipe-links": implemented(mealListRenderers["recipe-links"]),
    "meal-cost": implemented(mealListRenderers["meal-cost"]),
  },
  productCategory: scoredCoverage<"productCategory">(),
  // finance and project entities
  project: scoredCoverage<"project">(),
  task: scoredCoverage<"task">(),
  vendor: scoredCoverage<"vendor">(),
  financialAccount: scoredCoverage<"financialAccount">(),
  financialTransaction: {
    ...scoredCoverage<"financialTransaction">(),
    "possible-vendor": implemented(
      financialTransactionListRenderers["possible-vendor"],
    ),
    "spending-category-summary": implemented<
      ListRenderer<"financialTransaction">
    >((helper) => categorySummaryRenderer(helper)),
  },
  expense: scoredCoverage<"expense">(),
  wish: scoredCoverage<"wish">(),
  plant: scoredCoverage<"plant">(),
  planting: scoredCoverage<"planting">(),
  gardenEntry: scoredCoverage<"gardenEntry">(),
  ledgerParty: scoredCoverage<"ledgerParty">(),
  ledgerTransfer: scoredCoverage<"ledgerTransfer">(),
  device: scoredCoverage<"device">(),
  spendingCategory: {
    "data-quality": implemented<ListRenderer<"spendingCategory">>((helper) =>
      dataQualityRenderer(helper, false),
    ),
  },
  vendorAccount: {
    "data-quality": implemented<ListRenderer<"vendorAccount">>((helper) =>
      dataQualityRenderer(helper, false),
    ),
  },
  run: {
    "data-quality": implemented<ClientListRenderer<ClientListRows["run"]>>(
      (helper) => dataQualityRenderer(helper, false),
    ),
  },
  "usda-food": {
    "data-quality": implemented<
      ClientListRenderer<ClientListRows["usda-food"]>
    >((helper) => dataQualityRenderer(helper, false)),
  },
} satisfies {
  [E in ListRendererEntity]: EntityListRendererCoverage<E>;
};

/**
 * Resolves one named list renderer through a single audited erasure boundary.
 * The manifest binds `entity`, renderer id and field; callers pass the same
 * entity's helper and receive the same entity's column collection.
 */
export function listRendererColumns<TRecord extends object>(
  entity: Entity,
  renderer: string,
  helper: CubbyColumnHelper<TRecord>,
): CubbyColumnCollection<TRecord> {
  const entry = Object.entries(listRendererCoverage).find(
    ([key]) => key === entity,
  )?.[1];
  const disposition:
    | PresentationCoverage<
        ListRenderer<ListEntity> | ClientListRenderer<CookbookSummary>
      >
    | undefined =
    entry === undefined
      ? undefined
      : Object.entries(entry).find(([key]) => key === renderer)?.[1];
  if (disposition === undefined) {
    throw new Error(`No web list renderer coverage for ${entity}.${renderer}`);
  }
  if (disposition.kind !== "implemented") {
    throw new Error(`Web list renderer ${renderer} is not implemented`);
  }
  // SAFETY: the generated `ListRendererId<E>` registry proves the renderer
  // and helper share `entity`; only the public generic column compiler erases
  // that entity-specific row association.
  const rendered = disposition.implementation(helper as never);
  const erasedRendered: unknown = rendered;
  // SAFETY: the lookup above bound this renderer to the same TRecord helper
  // accepted by the generic column compiler.
  return erasedRendered as CubbyColumnCollection<TRecord>;
}

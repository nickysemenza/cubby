import { dataQuality } from "@cubby/schemas/data-quality";
import type { DataQuality } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import type { ListRendererId } from "@cubby/schemas/entity-manifest";
import type { SpendingCategorySummary } from "@cubby/schemas/spending-classification";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { z } from "zod";

import { featureRegistry } from "~/entity/feature-registry";
import type { ListEntity } from "~/entity/generated/entity-lists.gen";
import {
  RecipeSourceLink,
  sourceLabel,
} from "~/entity/presentation/recipe-source";
import { createImageColumn } from "~/entity/table/column-helpers";
import { numberCellData } from "~/ui/data-table/cell-data";
import {
  createCubbyColumnCollection,
  type CubbyColumnCollection,
  type CubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { NoneValue } from "~/ui/primitives/none-value";

import {
  implemented,
  type PresentationCoverage,
} from "../presentation-coverage";
import { DataQualityValue } from "./data-quality-value";
import { SpendingCategorySummaryValue } from "./detail-field-renderers/spending-category-summary";
import type { ListRenderer, ListRowOf } from "./list-renderer-types";
import { emailListRenderers } from "./list-renderers/email";
import { mealListRenderers } from "./list-renderers/meal";
import { productListRenderers } from "./list-renderers/product";
import { recipeListRenderers } from "./list-renderers/recipe";

/**
 * Entities outside the kernel list roster whose renderers still meet a row
 * the manifest list does not type: the external USDA catalog.
 */
type ClientListRows = {
  "usda-food": FoodSummaryWithLinkedProducts;
};

type ClientListRenderer<TRow extends object> = (
  helper: CubbyColumnHelper<TRow>,
) => CubbyColumnCollection<TRow>;

// Ranges over every entity, not just `ListEntity`: an entity with no generic
// list read (usda-food) still carries a disposition for each renderer id.
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
const qualityRow = z.object({ dataQuality: dataQuality.nullish() });
const dataQualityRenderer = <TRow extends object>(
  helper: CubbyColumnHelper<TRow>,
  scored = true,
): CubbyColumnCollection<TRow> =>
  createCubbyColumnCollection<TRow>((add) => {
    const qualityOf = (row: TRow) => qualityRow.parse(row).dataQuality;
    add(
      // A not-assessed (null) score sinks below every scored row in both
      // directions, matching the server's `NULLS LAST`.
      helper.accessor((row) => qualityOf(row)?.score ?? undefined, {
        id: "dataQuality",
        header: "Quality",
        enableSorting: scored,
        sortDescFirst: false,
        sortUndefined: "last",
        sortFn: (left, right) =>
          (qualityOf(left.original)?.score ?? 0) -
          (qualityOf(right.original)?.score ?? 0),
        meta: attachCubbyColumnMeta<TRow>({
          className: "w-20",
          // The score sorts numerically, but its status pill aligns with other values.
          cellData: numberCellData<TRow>(
            "number",
            (row) => qualityOf(row)?.score ?? null,
          ),
          mobile: { slot: "meta", priority: 0, showWhenEmpty: true },
        }),
        cell: (info) => {
          const quality = qualityOf(info.row.original);
          return (
            <DataQualityValue
              quality={quality ?? undefined}
              scored={scored && quality !== null}
            />
          );
        },
      }),
    );
  });

const unscoredCoverage = <
  E extends Exclude<ListEntity, ScoredListEntity>,
>() => ({
  "data-quality": implemented<ListRenderer<E>>((helper) =>
    dataQualityRenderer(helper, false),
  ),
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
const uploadedImageRenderer: ListRenderer<"image"> = (helper) =>
  createCubbyColumnCollection((add) => {
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
        meta: { className: "w-40", mobile: { slot: "meta", priority: 35 } },
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

const buildListRendererCoverage = () => {
  const {
    financialTransaction: financialTransactionListRenderers,
    location: locationListRenderers,
    purchase: purchaseListRenderers,
  } = featureRegistry().listRenderers;
  return {
    recipe: {
      "recipe-source": implemented(recipeSourceRenderer),
      ...scoredCoverage<"recipe">(),
      "estimate-cost": implemented(recipeListRenderers["estimate-cost"]),
      "estimate-kcal": implemented(recipeListRenderers["estimate-kcal"]),
    },
    product: {
      ...scoredCoverage<"product">(),
      "tag-links": implemented(productListRenderers["tag-links"]),
      "usda-food-link": implemented(productListRenderers["usda-food-link"]),
    },
    purchase: {
      ...scoredCoverage<"purchase">(),
      "spending-category-summary": implemented<ListRenderer<"purchase">>(
        (helper) => categorySummaryRenderer(helper),
      ),
      "vendor-cell": implemented(purchaseListRenderers["vendor-cell"]),
      "order-link": implemented(purchaseListRenderers["order-link"]),
      "financial-settlement": implemented(
        purchaseListRenderers["financial-settlement"],
      ),
      "reconciliation-status": implemented(
        purchaseListRenderers["reconciliation-status"],
      ),
    },
    // pantry and garden entities
    ingredient: scoredCoverage<"ingredient">(),
    cookbook: scoredCoverage<"cookbook">(),
    image: {
      "data-quality": implemented<ListRenderer<"image">>((helper) =>
        dataQualityRenderer(helper),
      ),
      "uploaded-image": implemented(uploadedImageRenderer),
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
    spendingCategory: scoredCoverage<"spendingCategory">(),
    vendorAccount: unscoredCoverage<"vendorAccount">(),
    email: {
      ...scoredCoverage<"email">(),
      "purchase-links": implemented(emailListRenderers["purchase-links"]),
    },
    run: scoredCoverage<"run">(),
    imageJob: scoredCoverage<"imageJob">(),
    "usda-food": {
      "data-quality": implemented<
        ClientListRenderer<ClientListRows["usda-food"]>
      >((helper) => dataQualityRenderer(helper, false)),
    },
  } satisfies {
    [E in ListRendererEntity]: EntityListRendererCoverage<E>;
  };
};

let listCoverage: ReturnType<typeof buildListRendererCoverage> | undefined;

/** Every list renderer disposition; transaction, location and purchase fills come from the feature registry. */
export const listRendererCoverage = () =>
  (listCoverage ??= buildListRendererCoverage());

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
  const entry = Object.entries(listRendererCoverage()).find(
    ([key]) => key === entity,
  )?.[1];
  const disposition:
    | PresentationCoverage<
        | ListRenderer<ListEntity>
        | ClientListRenderer<FoodSummaryWithLinkedProducts>
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

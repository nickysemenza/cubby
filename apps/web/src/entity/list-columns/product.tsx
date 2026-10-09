import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import {
  type ProductFilters,
  type ProductListItem,
  type ProductPricingOut,
} from "@cubby/schemas/product";
import type { KitComponentRowOut } from "@cubby/schemas/product-components";
import { formatCategoryLabel } from "@cubby/shared";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildProductTreeRows,
  groupComponentsByParent,
  isKitComponentRow,
  type ProductTreeRow,
  productTreeRowKey,
  productTreeSubRows,
} from "~/app/products/product-kit-rows";
import { ProductGtin } from "~/entity/components/product-gtin";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { entityListHiddenColumns } from "~/entity/entity-display";
import { relationshipFieldProvenance } from "~/entity/field-provenance";
import { useCreateInventoryMutation } from "~/features/inventory/hooks";
import { InventoryEntriesQuickEditDialog } from "~/features/inventory/inventory-entries-quick-edit-dialog";
import {
  product as productOperations,
  relatedData,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { booleanCellOptions } from "~/lib/select-options";
import { formatCurrency } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { treePickerItems } from "~/ui/combobox/tree-items";
import { useEntityListSource } from "~/ui/combobox/with-search-hook";
import {
  createBooleanColumn,
  createExternalLinkColumn,
  createSingleEntityInlineLinkColumn,
} from "~/ui/data-table/columnHelpers";
import { EditableCell } from "~/ui/data-table/editable-cell";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/ui/data-table/table-features";
import type { GroupConfig } from "~/ui/data-table/useGroupedList";
import { useDeferredFilterOptions } from "~/ui/hooks/useDeferredFilterOptions";
import { useTagOptions } from "~/ui/hooks/useEntityOptions";
import { useFilterOptions } from "~/ui/hooks/useFilterOptions";
import { useNameEditable } from "~/ui/hooks/useNameEditable";
import { useProductCategories } from "~/ui/hooks/useProductCategories";
import { useUpdateMutation } from "~/ui/hooks/useUpdateMutation";
import type { FilterableComboboxItem } from "~/ui/primitives/combobox";
import { NoneValue } from "~/ui/primitives/none-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

import { createInventoryEntriesColumn } from "./inventory";
import { useStableIds } from "./stable-ids";
import { defineListOverride, interleaveDeclared } from "./types";

// Module-level fallbacks keep the runtime options reference stable while a
// roster query is loading.
const NO_FILTER_OPTIONS: FilterableComboboxItem[] = [];
/** Stable empty default so `nest` keeps its identity while kits load. */
const EMPTY_KIT_ROWS: KitComponentRowOut[] = [];

// The generic tones fit here: tracked really is the resolved/good outcome.
const STOCK_TRACKED_OPTIONS = booleanCellOptions({
  true: "Tracked",
  false: "Not tracked",
});
// Stateless, so one per module; the collections below capture its row type.
const columnHelper = createCubbyColumnHelper<ProductTreeRow>();

// `components` is the one relation column outside the field model; every
// declared column hides itself through `display.listHidden`.
// A function, not a module-level const: entity-display imports the list renderers
// that import this module, so evaluating it at load hits the import cycle.
const productInitialColumnVisibility = () => ({
  components: false,
  ...entityListHiddenColumns("product"),
});

function useProductFilterOptions() {
  // Runtime picklist for the manifest's `tags` spec (optionsKey: "tags").
  const { options: tagOptions } = useTagOptions("product");
  const { categories } = useProductCategories();
  const projectOptions = useDeferredFilterOptions("project");
  const locationOptions = useDeferredFilterOptions("locationWithInventory");
  const ingredientOptions = useDeferredFilterOptions("ingredientWithProduct");
  const manufacturerOptionsQuery = useQuery(
    productOperations.manufacturerOptions.queryOptions(),
  );
  const externalIdSourceOptionsQuery = useQuery(
    productOperations.externalIdSourceOptions.queryOptions(),
  );
  const manufacturerOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      manufacturerOptionsQuery.data?.map(({ manufacturer, count }) => ({
        value: manufacturer,
        label: manufacturer,
        hint: String(count),
      })) ?? NO_FILTER_OPTIONS,
    [manufacturerOptionsQuery.data],
  );
  const externalIdSourceOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      externalIdSourceOptionsQuery.data?.map(({ source, count }) => ({
        value: source,
        label: source,
        hint: String(count),
      })) ?? NO_FILTER_OPTIONS,
    [externalIdSourceOptionsQuery.data],
  );
  // The graph owns these picklists: their count is distinct matching
  // Products, and keying by the relation offers only Vendors/Purchases that
  // can match a Product.
  const vendorOptionsQuery = useQuery(
    relatedData.options.queryOptions({
      relationKey: "product.vendors",
      limit: 100,
    }),
  );
  const purchaseOptionsQuery = useQuery(
    relatedData.options.queryOptions({
      relationKey: "product.purchases",
      limit: 100,
    }),
  );
  const vendorOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      vendorOptionsQuery.data?.map(({ id, label, count }) => ({
        value: id,
        label,
        hint: String(count),
      })) ?? NO_FILTER_OPTIONS,
    [vendorOptionsQuery.data],
  );
  const purchaseOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      purchaseOptionsQuery.data?.map(({ id, label, count }) => ({
        value: id,
        label,
        hint: String(count),
      })) ?? NO_FILTER_OPTIONS,
    [purchaseOptionsQuery.data],
  );
  return useFilterOptions({
    tags: tagOptions,
    productCategories: treePickerItems(categories, {
      idOf: (category) => category.id,
      parentIdOf: (category) => category.path.at(-2)?.id ?? null,
      labelOf: (category) => category.name,
    }).map((item) => ({
      value: item.id,
      label: item.name,
      group: item.presentation?.group,
      depth: item.presentation?.depth,
      rowLabel: item.presentation?.rowLabel,
    })),
    productCategoryFamilies: categories.flatMap((category) =>
      category.feature
        ? [
            {
              value: category.feature,
              label: category.name,
            },
          ]
        : [],
    ),
    productVendors: vendorOptions,
    project: projectOptions,
    productLocations: locationOptions,
    productIngredients: ingredientOptions,
    manufacturers: manufacturerOptions,
    productPurchases: purchaseOptions,
    externalIdSources: externalIdSourceOptions,
  });
}

const productGrouping = generatedEntitySort.product.grouping;
if (!productGrouping)
  throw new Error("product entity declares no list-grouping contract.");

// UI-only: the local (groups-less) fallback groups by the category's
// formatted path, and every group gets the same neutral swatch — unlike
// Location, categories have no inherent color. The server-key match once
// full-set groups load is generic (`useEntityList.tsx`'s
// `effectiveGroupConfig`, keyed by the declared `field`/`nullGroupKey`
// above), so this `keyFn` only has to look right before that data arrives.
const groupKeyFn = (item: ProductTreeRow) => formatCategoryLabel(item.category);
const groupColorFn = (_key: string) => "var(--chart-neutral)";
export const PRODUCT_GROUP_CONFIG: GroupConfig<ProductTreeRow> = {
  field: productGrouping.field,
  keyFn: groupKeyFn,
  // The raw value the server grouped on — the category id, not its label.
  rawKeyFn: (item) => item.categoryId,
  colorFn: groupColorFn,
};

export const productListOverride = defineListOverride<
  ProductTreeRow,
  ProductFilters,
  ProductListItem
>({
  use() {
    const filterOptions = useProductFilterOptions();
    const updateProductMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("product", "update"),
      entity: "product",
    });
    const updateInventoryMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("inventory", "update"),
      entity: "inventory",
    });
    const createInventoryMutation = useCreateInventoryMutation();
    // Column memos key on these stable functions, never on the mutation
    // result objects: those change every render, and a column rebuild
    // remounts every cell (it swallowed row-checkbox clicks mid-hover).
    const updateProduct = updateProductMutation.mutateAsync;
    const updateInventory = updateInventoryMutation.mutateAsync;
    const createInventory = createInventoryMutation.mutateAsync;
    const nameEditable = useNameEditable<ProductTreeRow>(updateProduct);

    // The dialog tracks an id and derives the product from live list data, so
    // post-save invalidation refreshes the open dialog too.
    const [quickEditProductId, setQuickEditProductId] = useState<string | null>(
      null,
    );

    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<ProductTreeRow>((add) => {
          add(
            columnHelper.accessor("primaryGtin", {
              header: "Barcode / ISBN",
              meta: {
                className: "w-32 font-mono",
                mobile: { interactive: true },
              },
              cell: (info) => {
                const value = info.getValue();
                return (
                  <EditableCell
                    value={value}
                    onSave={async (newValue) => {
                      await updateProduct({
                        id: info.row.original.id,
                        data:
                          newValue != null &&
                          wasm.normalize_isbn(newValue) != null
                            ? { isbn: newValue }
                            : { upc: newValue },
                      });
                    }}
                    config={{ type: "text" }}
                    trigger="pencil"
                    renderValue={(current) =>
                      current ? <ProductGtin gtin={current} /> : <NoneValue />
                    }
                  />
                );
              },
            }),
          );
          add(
            createExternalLinkColumn(columnHelper, "fdc_id", "/usda/$id", {
              className: "w-32",
              editable: {
                onSave: async (newValue, product) => {
                  await updateProduct({
                    id: product.id,
                    data: { fdc_id: newValue ? Number(newValue) : null },
                  });
                },
              },
            }),
          );
          // Editable, and tri-state on purpose: `null` is the undecided
          // backlog the "Products the ledger says you own" saved view filters
          // on, so this cell is where that view gets worked.
          add(
            createBooleanColumn(columnHelper, "stockTracked", {
              header: "Stock tracking",
              className: "w-28",
              placeholder: "Filter stock tracking...",
              trueFalseOptions: STOCK_TRACKED_OPTIONS,
              undecided: { label: "Undecided" },
              // The header control stays the manifest's presence filter
              // (undecided vs reviewed), which backs the worklist view.
              filterConfig: null,
              editable: {
                onSave: async (stockTracked, product) => {
                  await updateProduct({
                    id: product.id,
                    data: { stockTracked },
                  });
                },
              },
            }),
          );
          add(
            columnHelper.accessor((product) => product.pricing.effectivePrice, {
              id: "price",
              // A header FUNCTION: `createEntityDisplayColumns` replaces a
              // plain-string override header with the declared label
              // ("Valuation price", for the detail page's sake); a function
              // is the one shape it lets through, so the list heads "Price".
              header: () => "Price",
              meta: {
                numeric: true,
                className: "w-20",
                mobile: { slot: "trailing", priority: 10, interactive: true },
              },
              footer: (info) => {
                const total =
                  info.table.options.meta?.serverTotals?.sums?.price;
                return total !== undefined ? (
                  <span className="tabular-nums">{formatCurrency(total)}</span>
                ) : null;
              },
              cell: (info) => {
                const product = info.row.original;
                return (
                  <EditableCell
                    value={product.price}
                    onSave={async (price) => {
                      await updateProduct({
                        id: product.id,
                        data: { price },
                      });
                    }}
                    config={{
                      type: "currency",
                      clearable: {
                        label: productPriceClearLabel(product.pricing),
                      },
                    }}
                    renderValue={() => renderProductPriceValue(product.pricing)}
                  />
                );
              },
            }),
          );
        }),
      [updateProduct],
    );

    const compose = useCallback(
      (declared: CubbyColumnCollection<ProductTreeRow>) =>
        createCubbyColumnCollection<ProductTreeRow>((add) => {
          const { place, rest } = interleaveDeclared(declared, add);
          // Only the relation and inventory-entry columns sit outside the
          // field model; they interleave among the declared columns, whose
          // order this keeps.
          place("categoryId");
          add(
            createSingleEntityInlineLinkColumn(
              columnHelper,
              "ingredient",
              "ingredient",
              {
                header: "Ingredient",
                className: "w-32",
                mobile: { slot: "meta", priority: 45, interactive: true },
                enableSorting: true,
                provenance: relationshipFieldProvenance(
                  "product",
                  "ingredient",
                  "reference",
                ),
                editable: {
                  onSave: async (newIngredientId, product) => {
                    await updateProduct({
                      id: product.id,
                      data: { ingredientId: newIngredientId },
                    });
                  },
                  clearable: true,
                },
              },
            ),
          );
          place("categoryFeature");
          place("manufacturer");
          place("primaryGtin");
          place("fdc_id");
          place("model");
          place("notes");
          place("modelPresence");
          place("upcPresence");
          place("notesPresence");
          place("stockTracked");
          place("dataQuality");
          place("dataGaps");
          place("externalIds");
          place("price");
          place("unitPrice");
          place("expenseTotal");
          place("servingAsLocations");
          place("componentCount");
          place("ledgerExpectedQuantity");
          place("quantityVariance");
          place("purchaseDate");
          place("food");
          add(
            createInventoryEntriesColumn(
              columnHelper,
              "inventoryEntry",
              "location",
              (e) => e.location,
              {
                id: "location",
                enableSorting: true,
                mobile: { slot: "meta", priority: 40, interactive: true },
                provenance: relationshipFieldProvenance("product", "inventory"),
                onQuickEdit: (product) => setQuickEditProductId(product.id),
                inlineEdit: {
                  SearchProvider: (props) => {
                    const { dialog, ...search } = useEntityListSource(
                      "location",
                      { scope: props.scope },
                    );
                    return (
                      <>
                        {dialog}
                        {props.children(search)}
                      </>
                    );
                  },
                  onMoveEntry: async (entry, locationId) => {
                    await updateInventory({
                      id: entry.id,
                      data: { locationId },
                    });
                  },
                  onCreateEntry: async (product, locationId) => {
                    await createInventory({
                      productId: product.id,
                      locationId,
                      amount: { value: 1, unit: "each" },
                    });
                  },
                },
              },
            ),
          );
          place("tags");
          place("expenseCount");
          rest();
        }),
      [createInventory, updateInventory, updateProduct],
    );

    // Kits on the currently loaded pages, fetched for the whole page rather
    // than per expanded row: fetching on expand would deliver children AFTER
    // render, where `DesktopDataRow`'s memo (which compares `row.original`)
    // cannot see them. Nesting before rows are built sidesteps that.
    const [kitIds, setKitIds] = useState<string[]>([]);
    const kitComponentsQuery = useQuery({
      ...productOperations.kitComponentRows.queryOptions({
        parentProductIds: kitIds,
      }),
      enabled: kitIds.length > 0,
    });
    const componentsByParent = useMemo(
      () => groupComponentsByParent(kitComponentsQuery.data ?? EMPTY_KIT_ROWS),
      [kitComponentsQuery.data],
    );
    const tree = useMemo(
      () => ({
        nest: (rows: ProductListItem[]) =>
          buildProductTreeRows(rows, componentsByParent),
        getSubRows: productTreeSubRows,
        expandable: true,
        // `id` stays the real shortcode at both depths, so uniqueness lives
        // here — see `ProductTreeRow.rowKey`.
        rowKey: productTreeRowKey,
        // A component IS a Product, but it is shown as part of its kit: bulk
        // delete and the row menu act on whole selections, so its affordances
        // live on its own page.
        rowIsEntity: (row: ProductTreeRow) => !isKitComponentRow(row),
      }),
      [componentsByParent],
    );

    const list = useMemo(
      () => ({
        deletable: true as const,
        filterOptions,
        nameEditable,
        initialColumnVisibility: productInitialColumnVisibility(),
        groupConfig: PRODUCT_GROUP_CONFIG,
      }),
      [filterOptions, nameEditable],
    );

    return {
      overrides,
      compose,
      tree,
      list,
      below: ({ data }) => {
        const quickEditProduct = quickEditProductId
          ? (data.find((p) => p.id === quickEditProductId) ?? null)
          : null;
        return quickEditProduct ? (
          <InventoryEntriesQuickEditDialog
            open
            onOpenChange={(open) => {
              if (!open) setQuickEditProductId(null);
            }}
            productName={quickEditProduct.name}
            entries={quickEditProduct.inventoryEntry}
          />
        ) : null;
      },
      wrap: (children, { data }) => (
        <ProductListHydration data={data} onKitIds={setKitIds}>
          {children}
        </ProductListHydration>
      ),
    };
  },
});

/**
 * Derives the kit id set from the loaded rows as a stable array, so the query
 * key does not churn while the table rerenders.
 */
function ProductListHydration({
  data,
  onKitIds,
  children,
}: {
  data: ProductListItem[];
  onKitIds: (ids: string[]) => void;
  children: ReactNode;
}) {
  const kitCandidates = useMemo(
    () => data.filter((product) => product.componentCount > 0).map((p) => p.id),
    [data],
  );
  const stableKitIds = useStableIds(kitCandidates);
  useEffect(() => onKitIds([...stableKitIds]), [onKitIds, stableKitIds]);
  return children;
}

/**
 * `Product.pricing.source` in prose — the one place this ternary is spelled
 * out, so the detail-page caption and the cell tooltip (below) can't drift
 * apart on what "explicit" / "derived" / "none" mean to a reader.
 */
export function describeProductPricingSource(
  pricing: Pick<ProductPricingOut, "source" | "knownExpenseCount" | "partial">,
): string {
  switch (pricing.source) {
    case "explicit":
      return "Manual override";
    case "derived":
      return `Derived from ${pricing.knownExpenseCount} expense${pricing.knownExpenseCount === 1 ? "" : "s"}${pricing.partial ? " · partial history" : ""}`;
    case "none":
      return "No override or quantified purchase history";
  }
}

/**
 * `Product.price`'s `EditableCell` edits the manual override, but *displays*
 * `pricing.effectivePrice` — the override OR the Expense-derived fallback.
 * Both render as a plain number, so without a cue an override and a derived
 * price (and a cleared override that happens to land on the same digits as
 * the old one) are visually identical. The pin marks the exception (a manual
 * override); the derived norm stays unmarked, and the tooltip names either
 * source. This is that cue;
 * shared by the detail page and the list column so the two surfaces can't
 * disagree about what the cell means.
 */
export function renderProductPriceValue(
  pricing: Pick<
    ProductPricingOut,
    "effectivePrice" | "source" | "knownExpenseCount" | "partial"
  >,
): ReactNode {
  if (pricing.effectivePrice === null) return <NoneValue />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex items-center gap-1" />}
      >
        {pricing.source === "explicit" ? (
          <PushPinIcon
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground"
          />
        ) : null}
        {formatCurrency(pricing.effectivePrice)}
      </TooltipTrigger>
      <TooltipContent side="top">
        {describeProductPricingSource(pricing)}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Label for `Product.price`'s currency-clear control: names the state
 * clearing the override lands on, so the button reads as "go back to the
 * derived price" rather than an unlabelled "clear". Shared by the detail
 * page and the list column so a clear affordance can't say something
 * different on one surface than the other.
 */
export function productPriceClearLabel(
  pricing: Pick<ProductPricingOut, "derivedPrice">,
): string {
  return pricing.derivedPrice !== null
    ? `Revert to ${formatCurrency(pricing.derivedPrice)} (derived)`
    : "Clear override (no derived price on record)";
}

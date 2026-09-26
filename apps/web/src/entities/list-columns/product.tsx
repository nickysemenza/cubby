import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import {
  type ProductFilters,
  type ProductListItem,
} from "@cubby/schemas/product";
import type { KitComponentRowOut } from "@cubby/schemas/product-components";
import { formatCategoryLabel } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { treePickerItems } from "~/app/_components/combobox/tree-items";
import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import {
  createBooleanColumn,
  createExternalLinkColumn,
  createInventoryEntriesColumn,
  createSingleEntityInlineLinkColumn,
  productPriceClearLabel,
  renderOptionCell,
  renderProductPriceValue,
} from "~/app/_components/data-table/columnHelpers";
import { EditableCell } from "~/app/_components/data-table/editable-cell";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import type { GroupConfig } from "~/app/_components/data-table/useGroupedList";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useDeferredFilterOptions } from "~/app/_components/hooks/useDeferredFilterOptions";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useProductCategories } from "~/app/_components/hooks/useProductCategories";
import { useProductTagOptions } from "~/app/_components/hooks/useProductTagOptions";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { useCreateInventoryMutation } from "~/app/_components/inventory/hooks";
import { InventoryEntriesQuickEditDialog } from "~/app/_components/inventory/inventory-entries-quick-edit-dialog";
import { TruncatedList } from "~/app/_components/TruncatedList";
import { UnitPriceLine } from "~/app/_components/units/unit-price-line";
import {
  buildProductTreeRows,
  groupComponentsByParent,
  isKitComponentRow,
  type ProductTreeRow,
  productTreeRowKey,
  productTreeSubRows,
} from "~/app/products/product-kit-rows";
import { product as productOperations } from "~/app/products/product.functions";
import { ProductGtin } from "~/components/entity/product-gtin";
import { Badge } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { NoneValue } from "~/components/ui/none-value";
import { OptionalStatusText, StatusText } from "~/components/ui/status-text";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListHiddenColumns } from "~/entities/entity-display";
import {
  entityFieldProvenance,
  labeledFieldProvenance,
  relationshipFieldProvenance,
} from "~/entities/field-provenance";
import { relatedData } from "~/lib/related-data.functions";
import { booleanCellOptions, presenceCellOptions } from "~/lib/select-options";
import { formatCurrency } from "~/lib/utils";
import { wasm } from "~/lib/wasm";

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
const MODEL_PRESENCE_OPTIONS = presenceCellOptions("model");
const UPC_PRESENCE_OPTIONS = presenceCellOptions("UPC");
const NOTES_PRESENCE_OPTIONS = presenceCellOptions("notes");

// Stateless, so one per module; the collections below capture its row type.
const columnHelper = createCubbyColumnHelper<ProductTreeRow>();

// `dataGaps`/`modelPresence`/`upcPresence`/`notesPresence` are filter-hosting
// synthetic columns and `components` is a relation column — none has a
// matching `model.fields` entry, so they stay hand-declared here.
const PRODUCT_INITIAL_COLUMN_VISIBILITY = {
  categoryFeature: false,
  dataGaps: false,
  modelPresence: false,
  upcPresence: false,
  notesPresence: false,
  components: false,
  ...entityListHiddenColumns("product"),
};

/**
 * Units bought minus units gone, with its own uncertainty attached.
 *
 * The `+N?` / `−N?` suffixes are load-bearing: an expense line with no
 * recorded quantity contributes nothing to the number, so a product with six
 * unquantified receipts would otherwise read as a confident 0. Both directions
 * are disclosed — an unknown acquisition means the real count could be
 * higher, an unknown exit that it could be lower.
 */
function ExpectedQuantityCell({
  ledger,
}: {
  ledger: ProductListItem["quantityLedger"];
}) {
  const detail = [
    `${ledger.acquiredUnits} acquired − ${ledger.exitedUnits} gone`,
    ledger.unknownAcquisitionLines > 0
      ? `${ledger.unknownAcquisitionLines} acquisition line(s) carry no quantity`
      : null,
    ledger.unknownExitLines > 0
      ? `${ledger.unknownExitLines} exit line(s) carry no quantity`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="tabular-nums" />}>
        <OptionalStatusText
          tone={ledger.expectedQuantity < 0 ? "destructive" : undefined}
        >
          {ledger.expectedQuantity}
        </OptionalStatusText>
        {ledger.unknownAcquisitionLines > 0 ? (
          <StatusText tone="warning">
            {` +${ledger.unknownAcquisitionLines}?`}
          </StatusText>
        ) : null}
        {ledger.unknownExitLines > 0 ? (
          <StatusText tone="warning">
            {` −${ledger.unknownExitLines}?`}
          </StatusText>
        ) : null}
      </TooltipTrigger>
      <TooltipContent side="top">{detail}</TooltipContent>
    </Tooltip>
  );
}

function ProductFoodCell({ product }: { product: ProductListItem }) {
  const food = product.food;
  return food ? (
    <EntityInlineLink
      displayImage={null}
      entity="usda-food"
      data={food}
      compact
    />
  ) : (
    <NoneValue />
  );
}

function useProductFilterOptions() {
  // Runtime picklist for the manifest's `tags` spec (optionsKey: "tags").
  const { options: tagOptions } = useProductTagOptions();
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
    const nameEditable = useNameEditable<ProductTreeRow>(
      updateProductMutation.mutateAsync,
    );

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
                      await updateProductMutation.mutateAsync({
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
                  await updateProductMutation.mutateAsync({
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
                  await updateProductMutation.mutateAsync({
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
                return total ? (
                  <span className="tabular-nums">{formatCurrency(total)}</span>
                ) : null;
              },
              cell: (info) => {
                const product = info.row.original;
                return (
                  <EditableCell
                    value={product.price}
                    onSave={async (price) => {
                      await updateProductMutation.mutateAsync({
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
          // Counts render a literal `0`, not a dash: `locationCount` and
          // `componentCount` are never null, so "none" is a known fact and a
          // dash would claim "unknown".
          add(
            columnHelper.accessor((row) => row.quantityLedger.locationCount, {
              id: "servingAsLocations",
              header: "In service",
              meta: {
                numeric: true,
                className: "w-24",
                mobile: { slot: "meta", priority: 43 },
              },
              cell: (info) => info.getValue(),
            }),
          );
          add(
            columnHelper.accessor(
              (row) => row.quantityLedger.expectedQuantity,
              {
                id: "ledgerExpectedQuantity",
                header: "Expected",
                meta: {
                  numeric: true,
                  className: "w-24",
                  mobile: { slot: "meta", priority: 45 },
                },
                cell: (info) => (
                  <ExpectedQuantityCell
                    ledger={info.row.original.quantityLedger}
                  />
                ),
              },
            ),
          );
          // Shelf minus ledger. Dashes when the product isn't stocked, and
          // when its entries carry more than one unit (see `deriveOnHandUnits`).
          add(
            columnHelper.accessor((row) => row.quantityVariance, {
              id: "quantityVariance",
              header: "Variance",
              meta: {
                numeric: true,
                className: "w-24",
                mobile: { slot: "meta", priority: 44 },
              },
              cell: (info) => {
                const { quantityVariance, onHandUnits, quantityLedger } =
                  info.row.original;
                if (quantityVariance === null || onHandUnits === null) {
                  return <NoneValue />;
                }
                return (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        quantityVariance === 0 ? (
                          <span className="tabular-nums" />
                        ) : (
                          <StatusText
                            as="span"
                            tone="warning"
                            className="tabular-nums"
                          />
                        )
                      }
                    >
                      {quantityVariance > 0
                        ? `+${quantityVariance}`
                        : quantityVariance}
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {`${onHandUnits} on hand vs. ${quantityLedger.expectedQuantity} expected`}
                    </TooltipContent>
                  </Tooltip>
                );
              },
            }),
          );
          // Read-only: the Tags filter spec declares `columnId: "tags"`, and
          // the header-filter machinery needs a real column to hang on.
          add(
            columnHelper.accessor("tags", {
              id: "tags",
              header: "Tags",
              meta: {
                className: "w-40",
                mobile: { slot: "meta", priority: 60 },
              },
              cell: (info) => {
                const tags = info.getValue();
                if (!tags.length) return <NoneValue />;
                return (
                  <TruncatedList
                    items={tags}
                    maxItems={2}
                    // `stopPropagation`: rows carry the preview onRowClick and
                    // TanStack's Link preventDefaults without stopping
                    // propagation, so the chip would also open the sheet.
                    renderItem={(tag) => (
                      <Link
                        key={tag}
                        to="/products"
                        search={{ tags: tag }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Badge variant="outline">{tag}</Badge>
                      </Link>
                    )}
                  />
                );
              },
            }),
          );
          add(
            columnHelper.accessor("expenseCount", {
              id: "expenseCount",
              header: "Expenses",
              // The column id is `expenses` while the row field is
              // `expenseCount`: the id is persisted per-user in the
              // `table-columns:product` localStorage key and matched by
              // `productSortableFields` and repo/product/crud.ts's orderBy.
              enableSorting: true,
              meta: {
                numeric: true,
                className: "w-24",
                mobile: { slot: "meta", priority: 50, interactive: true },
              },
              cell: (info) => {
                const count = info.getValue();
                if (!count) return <NoneValue />;
                return (
                  <Link
                    to="/expenses"
                    search={{ productId: info.row.original.id }}
                    className="text-primary tabular-nums transition-colors hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {count}
                  </Link>
                );
              },
            }),
          );
        }),
      [updateProductMutation],
    );

    const compose = useCallback(
      (declared: CubbyColumnCollection<ProductTreeRow>) =>
        createCubbyColumnCollection<ProductTreeRow>((add) => {
          const { place, rest } = interleaveDeclared(declared, add);
          // Interleaved with the declared columns to keep the column order:
          // these aren't ordinary stored scalars (a relation, computed
          // presence flags, a derived food projection, a second projection
          // hosting a filter control), so they stay explicit `add()`s per
          // docs/entities.md's third bucket.
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
                    await updateProductMutation.mutateAsync({
                      id: product.id,
                      data: { ingredientId: newIngredientId },
                    });
                  },
                  clearable: true,
                },
              },
            ),
          );
          add(
            columnHelper.accessor(
              (row) => row.category?.path[0]?.name ?? null,
              {
                id: "categoryFeature",
                header: "Category family",
                meta: {
                  provenance: relationshipFieldProvenance(
                    "product",
                    "category",
                    "reference",
                  ),
                },
                enableSorting: false,
                cell: (info) => info.getValue() ?? <NoneValue />,
              },
            ),
          );
          place("manufacturer");
          place("primaryGtin");
          place("fdc_id");
          place("model");
          place("notes");
          add(
            columnHelper.accessor((row) => row.modelPresence, {
              id: "modelPresence",
              header: "Model present",
              enableSorting: false,
              meta: {
                provenance: labeledFieldProvenance("Product record"),
                explanation: {
                  entity: "product",
                  field: "modelPresence",
                  label: "Model present",
                },
                className: "w-24",
              },
              cell: (info) =>
                renderOptionCell(
                  info.getValue() ? "yes" : "no",
                  MODEL_PRESENCE_OPTIONS,
                ),
            }),
          );
          add(
            columnHelper.accessor((row) => row.upcPresence, {
              id: "upcPresence",
              header: "UPC present",
              enableSorting: false,
              meta: {
                provenance: labeledFieldProvenance("Product record"),
                explanation: {
                  entity: "product",
                  field: "upcPresence",
                  label: "UPC present",
                },
                className: "w-24",
              },
              cell: (info) =>
                renderOptionCell(
                  info.getValue() ? "yes" : "no",
                  UPC_PRESENCE_OPTIONS,
                ),
            }),
          );
          add(
            columnHelper.accessor((row) => row.notesPresence, {
              id: "notesPresence",
              header: "Notes present",
              enableSorting: false,
              meta: {
                provenance: labeledFieldProvenance("Product record"),
                explanation: {
                  entity: "product",
                  field: "notesPresence",
                  label: "Notes present",
                },
                className: "w-24",
              },
              cell: (info) =>
                renderOptionCell(
                  info.getValue() ? "yes" : "no",
                  NOTES_PRESENCE_OPTIONS,
                ),
            }),
          );
          place("stockTracked");
          place("dataQuality");
          add(
            columnHelper.accessor((row) => row.dataGaps, {
              id: "dataGaps",
              header: "Data gaps",
              enableSorting: false,
              meta: {
                provenance: labeledFieldProvenance("Product data quality"),
                explanation: {
                  entity: "product",
                  field: "dataGaps",
                  label: "Data gaps",
                },
                className: "w-36",
                mobile: { slot: "meta", priority: 80 },
              },
              cell: (info) => {
                const gaps = info.getValue();
                if (!gaps.length) return <NoneValue />;
                return (
                  <span className="text-xs text-muted-foreground">
                    {gaps.map((gap) => gap.replaceAll("_", " ")).join(", ")}
                  </span>
                );
              },
            }),
          );
          place("externalIds");
          place("price");
          // Comparable unit price is projected by the server from the same
          // effective price and complete conversion graph the explanation
          // reads. It remains display-only because the list query does not
          // expose server sorting for this derived value.
          add(
            columnHelper.display({
              id: "unitPrice",
              header: "Unit price",
              meta: {
                provenance: labeledFieldProvenance("Product price and units"),
                explanation: {
                  entity: "product",
                  field: "unitPrice",
                  label: "Unit price",
                },
                numeric: true,
                className: "w-24",
              },
              cell: (info) => (
                <UnitPriceLine prices={info.row.original.unitPrice} compact />
              ),
            }),
          );
          place("expenseTotal");
          place("servingAsLocations");
          place("componentCount");
          place("ledgerExpectedQuantity");
          place("quantityVariance");
          place("purchaseDate");
          add(
            columnHelper.display({
              id: "food",
              header: "USDA Food",
              // No mobile slot: a display column escapes the model's
              // empty-value check, and most products have no USDA link.
              meta: {
                provenance: entityFieldProvenance("usda-food"),
                explanation: {
                  entity: "product",
                  field: "food",
                  label: "USDA Food",
                },
                className: "w-32",
              },
              cell: ({ row }) => <ProductFoodCell product={row.original} />,
            }),
          );
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
                  SearchProvider: (props) => (
                    <WithEntitySearch entity="location" {...props} />
                  ),
                  onMoveEntry: async (entry, locationId) => {
                    await updateInventoryMutation.mutateAsync({
                      id: entry.id,
                      data: { locationId },
                    });
                  },
                  onCreateEntry: async (product, locationId) => {
                    await createInventoryMutation.mutateAsync({
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
      [createInventoryMutation, updateInventoryMutation, updateProductMutation],
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
        initialColumnVisibility: PRODUCT_INITIAL_COLUMN_VISIBILITY,
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

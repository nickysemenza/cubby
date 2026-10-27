import type { EntityFieldEnvelopeRead } from "@cubby/schemas/entity-field-envelopes";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { type ProductFilters } from "@cubby/schemas/product";

import { ProductCostValue } from "~/entity/display/product-cost-value";
type ProductListItem = EntityFieldEnvelopeRead<"product", "list">;
import type { KitComponentRowOut } from "@cubby/schemas/product-components";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProductGtin } from "~/entity/components/product-gtin";
import { entityListHiddenColumns } from "~/entity/display/entity-display";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { relationshipFieldProvenance } from "~/entity/fields/field-provenance";
import { useDeferredFilterOptions } from "~/entity/hooks/use-deferred-filter-options";
import { useFilterOptions } from "~/entity/hooks/use-filter-options";
import { useNameEditable } from "~/entity/hooks/use-name-editable";
import { useProductCategories } from "~/entity/hooks/use-product-categories";
import { useUpdateMutation } from "~/entity/hooks/use-update-mutation";
import { useEntityListSource } from "~/entity/picker/with-search-hook";
import {
  createBooleanColumn,
  createExternalLinkColumn,
  createSingleEntityInlineLinkColumn,
} from "~/entity/table/column-helpers";
import { EditableCell } from "~/entity/table/editable-cell";
import { useCreateInventoryMutation } from "~/features/inventory/hooks/use-inventory-mutation";
import { InventoryEntriesQuickEditDialog } from "~/features/inventory/inventory-entries-quick-edit-dialog";
import {
  buildProductTreeRows,
  groupComponentsByParent,
  isKitComponentRow,
  type ProductTreeRow,
  productTreeRowKey,
  productTreeSubRows,
} from "~/features/product/product-kit-rows";
import { product as productOperations } from "~/integrations/tanstack-query/generated/catalog/product.gen";
import { relatedData } from "~/integrations/tanstack-query/generated/catalog/relatedData.gen";
import { formatCurrency } from "~/lib/number-format";
import { booleanCellOptions } from "~/lib/select-options";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { treePickerItems } from "~/ui/combobox/tree-items";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/ui/data-table/table-features";
import { useTagOptions } from "~/ui/hooks/use-entity-options";
import { NoneValue } from "~/ui/primitives/none-value";

import { useStableIds } from "../../entity/list-columns/stable-ids";
import {
  defineListOverride,
  interleaveDeclared,
} from "../../entity/list-columns/types";
import { createInventoryEntriesColumn } from "../inventory/list-columns";

// Module-level fallbacks keep the runtime options reference stable while a
// roster query is loading.
const NO_FILTER_OPTIONS: PickerOption[] = [];
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
  const externalIdSourceOptionsQuery = useQuery(
    productOperations.externalIdSourceOptions.queryOptions(),
  );
  const externalIdSourceOptions = useMemo<PickerOption[]>(
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
  const vendorOptions = useMemo<PickerOption[]>(
    () =>
      vendorOptionsQuery.data?.map(({ id, label, count }) => ({
        value: id,
        label,
        hint: String(count),
      })) ?? NO_FILTER_OPTIONS,
    [vendorOptionsQuery.data],
  );
  const purchaseOptions = useMemo<PickerOption[]>(
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
      parentIdOf: (category) => {
        const effectiveCategoryPath = fieldValueOf(category.fields.path);
        return effectiveCategoryPath?.at(-2)?.id ?? null;
      },
      labelOf: (category) => category.name,
    }).map((item) => ({
      value: item.id,
      label: item.name,
      group: item.presentation?.group,
      depth: item.presentation?.depth,
      rowLabel: item.presentation?.rowLabel,
    })),
    productCategoryFamilies: categories.flatMap((category) => {
      const effectiveCategoryFeature = fieldValueOf(category.fields.feature);
      return effectiveCategoryFeature
        ? [
            {
              value: effectiveCategoryFeature,
              label: category.name,
            },
          ]
        : [];
    }),
    productVendors: vendorOptions,
    project: projectOptions,
    productLocations: locationOptions,
    productIngredients: ingredientOptions,
    vendor: useDeferredFilterOptions("vendor"),
    productPurchases: purchaseOptions,
    externalIdSources: externalIdSourceOptions,
  });
}

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
            columnHelper.accessor(
              (row) => fieldValueOf(row.fields.primaryGtin),
              {
                id: "primaryGtin",
                header: "Barcode / ISBN",
                meta: {
                  readFields: ["primaryGtin"],
                  className: "w-24",
                  mono: true,
                  code: true,
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
                          data: { barcode: newValue },
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
              },
            ),
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
          // backlog the "Not on a shelf" saved view filters on, so this cell
          // is where that view gets worked. It shows the effective decision
          // (the product's own, else its category's — ADR 0013) and edits the
          // product's own.
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
            columnHelper.accessor(
              (product) => fieldValueOf(product.fields.cost)?.amount,
              {
                id: "cost",
                header: () => "Cost",
                meta: {
                  readFields: ["cost", "price"],
                  numeric: true,
                  className: "w-32",
                  mobile: { slot: "trailing", priority: 10, interactive: true },
                },
                footer: (info) => {
                  const total =
                    info.table.options.meta?.serverTotals?.sums?.price;
                  return total !== undefined ? (
                    <span
                      className="tabular-nums"
                      title="Item prices only; service averages are excluded."
                    >
                      {formatCurrency(total)}
                    </span>
                  ) : null;
                },
                cell: (info) => {
                  const product = info.row.original;
                  const price = product.fields.price;
                  if (price.current.controls.kind === "readonly")
                    return <ProductCostValue envelope={product.fields.cost} />;
                  return (
                    <EditableCell
                      value={
                        price.current.assignment?.kind === "value"
                          ? price.current.assignment.value
                          : null
                      }
                      onSave={async (price) => {
                        await updateProduct({
                          id: product.id,
                          data: { price },
                        });
                      }}
                      config={{
                        type: "currency",
                        clearable: { label: "Use inherited" },
                      }}
                      renderValue={() => (
                        <ProductCostValue envelope={product.fields.cost} />
                      )}
                    />
                  );
                },
              },
            ),
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
                columnGroup: "Food",
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
          place("brandName");
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
          place("cost");
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
              (e: ProductListItem["inventoryEntry"][number]) => e.location,
              {
                id: "location",
                columnGroup: "Stock",
                context: (product) => fieldValueOf(product.fields.stockStatus),
                contextReadFields: ["stockStatus"],
                explanation: {
                  entity: "product",
                  field: "stockStatus",
                  label: "Locations",
                },
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
          place("owners");
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
    () =>
      data
        .filter(
          (product) => (fieldValueOf(product.fields.componentCount) ?? 0) > 0,
        )
        .map((p) => p.id),
    [data],
  );
  const stableKitIds = useStableIds(kitCandidates);
  useEffect(() => onKitIds([...stableKitIds]), [onKitIds, stableKitIds]);
  return children;
}

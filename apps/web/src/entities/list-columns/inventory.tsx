import type { EntityFieldProvenance } from "@cubby/schemas/entity-fields";
import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { inventoryListItemOut } from "@cubby/schemas/inventory";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import type { z } from "zod";

import type { SearchProviderProps } from "~/app/_components/combobox/with-search-hook";
import { createEditableAmountColumn, createSingleEntityInlineLinkColumn } from "~/app/_components/data-table/columnHelpers";
import type {
  InventoryEntryBase,
  InventoryRelatedEntity,
} from "~/app/_components/data-table/inventory-column-helpers";
import {
  InventoryEntriesCell,
  type InventoryEntriesCellProps,
} from "~/app/_components/data-table/inventory-entries-cell";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
  type CubbyColumnHelper as ColumnHelper,
} from "~/app/_components/data-table/table-features";
import {
  attachCubbyColumnMeta,
  type FilterConfig,
  type MobileColumnMeta,
} from "~/app/_components/data-table/table-meta";
import {
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "~/app/_components/entity-media/entity-display-images";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { useProductCategories } from "~/app/_components/hooks/useProductCategories";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { CategoryLabel } from "~/app/_components/products/CategoryLabel";
import { EntityRefLink } from "~/components/entity/entity-ref-link";
import { ProductGtin } from "~/components/entity/product-gtin";
import { Stack } from "~/components/layout";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { relationshipFieldProvenance } from "~/entities/field-provenance";
import { multiSelectFilterFn } from "~/entities/filters";
import type { EntityListParamsByEntity } from "~/entities/generated/entity-lists.gen";

import { defineListOverride, interleaveDeclared } from "./types";

type InventoryListItem = z.infer<typeof inventoryListItemOut>;
type InventoryFilters = EntityListParamsByEntity["inventory"]["filters"];

const columnHelper = createCubbyColumnHelper<InventoryListItem>();

function InventoryProductLink({
  product,
}: {
  product: InventoryListItem["product"];
}) {
  const displayImage = useEntityDisplayImage({
    entityKind: "product",
    entityId: product.id,
  });
  return (
    <EntityRefLink
      displayImage={displayImage}
      entity="product"
      data={product}
      compact
    />
  );
}

/**
 * An inventory entry is about its product, so product verbs — "add another
 * of these here" — reach this row without the inventory table declaring one.
 */
const PRODUCT_SUBJECT = {
  readFields: ["product"],
  entity: "product" as const,
  resolve: (row: InventoryListItem) => ({
    entity: "product" as const,
    id: row.product.id,
    name: row.product.name,
  }),
};

// "Created" is low-signal when browsing inventory; the product attributes
// exist so "show me the Milwaukee stuff" is a header filter.
const INVENTORY_INITIAL_COLUMN_VISIBILITY = {
  createdAt: false,
  manufacturer: false,
  category: false,
};

export const inventoryListOverride = defineListOverride<
  InventoryListItem,
  InventoryFilters
>({
  use() {
    const { categories } = useProductCategories();
    const filterOptions = useFilterOptions({
      productCategories: categories.map((category) => ({
        value: category.id,
        label: category.path.map((node) => node.name).join(" / "),
      })),
    });
    const updateMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("inventory", "update"),
      entity: "inventory",
    });
    // Its own config rather than the contract default: the dialog says
    // "Inventory Entry", which is what the row IS.
    const deletable = useDeletableConfig({
      mutationFn: entityMutationOptionsFactory("inventory", "delete"),
      entityLabel: "Inventory Entry",
      entity: "inventory",
    });

    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<InventoryListItem>((add) => {
          add(
            createEditableAmountColumn(columnHelper, "amount", {
              header: "Qty",
              className: "w-36",
              mobile: { slot: "trailing", priority: 10 },
              onSave: async (newAmount, row) => {
                await updateMutation.mutateAsync({
                  id: row.id,
                  data: { amount: newAmount },
                });
              },
              // The click-through to the entry's detail page survives the
              // editable (same link-in-display pattern as the name column).
              renderDisplay: (content, row) => (
                <Link
                  to={entities.inventory.routes.detail}
                  params={entityDetailParams(row.id)}
                >
                  {content}
                </Link>
              ),
            }),
          );
        }),
      // oxlint-disable-next-line react/exhaustive-deps -- updateMutation changes every render but is functionally stable
      [],
    );

    const compose = useMemo(
      () => (declared: CubbyColumnCollection<InventoryListItem>) =>
        createCubbyColumnCollection<InventoryListItem>((add) => {
          const { place, rest } = interleaveDeclared(declared, add);
          place("amount");
          place("valuation");
          add(
            columnHelper.accessor("product", {
              header: "Product",
              enableSorting: false,
              meta: {
                provenance: relationshipFieldProvenance(
                  "inventory",
                  "product",
                  "reference",
                ),
                className: "min-w-0 w-64",
                surplus: true,
                mobile: { slot: "meta", priority: 50 },
                filterConfig: { placeholder: "Filter product..." },
              },
              cell: (info) => {
                const product = info.getValue();
                return (
                  <Stack gap="xs" className="min-w-0 flex-1">
                    <InventoryProductLink product={product} />
                    {product.primaryGtin && (
                      <div className="text-xs text-muted-foreground">
                        <ProductGtin gtin={product.primaryGtin} />
                      </div>
                    )}
                  </Stack>
                );
              },
            }),
          );
          add(
            createSingleEntityInlineLinkColumn(
              columnHelper,
              "location",
              "location",
              {
                className: "min-w-0 w-40 max-w-56",
                mobile: { slot: "subtitle", priority: 20 },
                filterConfig: { placeholder: "Filter location..." },
                provenance: relationshipFieldProvenance(
                  "inventory",
                  "location",
                  "reference",
                ),
                editable: {
                  // Not clearable, so the fallback only satisfies the
                  // optional (non-nullable) `locationId` update field.
                  onSave: async (newLocationId, row) => {
                    await updateMutation.mutateAsync({
                      id: row.id,
                      data: { locationId: newLocationId ?? undefined },
                    });
                  },
                },
              },
            ),
          );
          add(
            columnHelper.accessor((row) => row.product.manufacturer, {
              id: "manufacturer",
              header: "Manufacturer",
              enableSorting: false,
              meta: {
                provenance: relationshipFieldProvenance("inventory", "product"),
                className: "min-w-0 w-40 truncate",
                mobile: { slot: "meta", priority: 70 },
                filterConfig: { placeholder: "Filter by manufacturer..." },
              },
              cell: (info) => info.getValue() || <NoneValue />,
            }),
          );
          add(
            columnHelper.accessor((row) => row.product.category, {
              id: "category",
              header: "Category",
              enableSorting: false,
              filterFn: multiSelectFilterFn,
              meta: {
                provenance: relationshipFieldProvenance("inventory", "product"),
                className: "w-32",
                mobile: { slot: "meta", priority: 75 },
                filterConfig: {
                  placeholder: "Filter by category...",
                  filterType: "multiselect",
                },
              },
              cell: (info) => <CategoryLabel category={info.getValue()} />,
            }),
          );
          place("verifiedAt");
          rest();
        }),
      // oxlint-disable-next-line react/exhaustive-deps -- updateMutation changes every render but is functionally stable
      [],
    );

    const list = useMemo(
      () => ({
        deletable,
        filterOptions,
        subject: PRODUCT_SUBJECT,
        initialColumnVisibility: INVENTORY_INITIAL_COLUMN_VISIBILITY,
      }),
      [deletable, filterOptions],
    );

    return {
      overrides,
      compose,
      list,
      wrapReadFields: ["product", "location"],
      wrap: (children, { data }) => (
        <EntityDisplayImagesProvider
          refs={data.flatMap((row) => [
            { entityKind: "product" as const, entityId: row.product.id },
            { entityKind: "location" as const, entityId: row.location.id },
          ])}
        >
          {children}
        </EntityDisplayImagesProvider>
      ),
    };
  },
});

export function createInventoryEntriesColumn<
  TEntry extends InventoryEntryBase,
  TEntity extends InventoryRelatedEntity["entity"],
  K extends PropertyKey,
  T extends Record<K, TEntry[]>,
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  entity: TEntity,
  getRelatedEntity: InventoryEntriesCellProps<
    T,
    TEntry,
    TEntity
  >["getRelatedEntity"],
  options?: {
    id?: string;
    header?: string;
    className?: string;
    enableSorting?: boolean;
    layout?: "stacked" | "inline";
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    provenance?: EntityFieldProvenance;
    /**
     * When set, rows with entries get a hover-revealed pencil that opens a
     * quick-edit surface (e.g. the per-entry inventory dialog). A pencil
     * affordance rather than a whole-cell click target: the entry links inside
     * the cell must stay navigable, and interactive-inside-interactive nesting
     * is invalid.
     */
    onQuickEdit?: (row: T) => void;
    /**
     * Inline edit + clipboard on the 0/1-entry cases: an `EditableEntityCell`
     * (pencil trigger) lets you move the single entry's location, or create a
     * new entry at a picked location when there are none. Only meaningful for
     * entity === "location" + layout === "inline" — ignored otherwise (e.g.
     * LocationList's Products column, or the "stacked" layout).
     */
    inlineEdit?: {
      /** `useEntityListSource("location", ...)` — injected so unit tests can stub it. */
      SearchProvider: (
        props: SearchProviderProps<LocationShortcode>,
      ) => ReactNode;
      onMoveEntry: (
        entry: TEntry,
        locationId: LocationShortcode,
      ) => Promise<void>;
      onCreateEntry: (row: T, locationId: LocationShortcode) => Promise<void>;
    };
  },
) {
  const layout = options?.layout ?? "inline";

  return columnHelper.accessor((row: T) => row[accessor], {
    id: options?.id ?? String(accessor),
    header:
      options?.header ?? (entity === "location" ? "Locations" : "Products"),
    enableSorting: options?.enableSorting ?? false,
    meta: attachCubbyColumnMeta<T>({
      className: options?.className ?? "min-w-0 w-40 max-w-56",
      mobile: options?.mobile,
      filterConfig: options?.filterConfig,
      provenance: options?.provenance,
      readFields: [String(accessor)],
      entityRefs: (row) =>
        row[accessor].flatMap((entry) => {
          const related = getRelatedEntity(entry);
          return related ? [{ entityKind: entity, entityId: related.id }] : [];
        }),
    }),
    cell: (info) => (
      <InventoryEntriesCell<T, TEntry, TEntity>
        entries={info.getValue() ?? []}
        entity={entity}
        getRelatedEntity={getRelatedEntity}
        layout={layout}
        row={info.row.original}
        onQuickEdit={options?.onQuickEdit}
        inlineEdit={
          entity === "location" && layout === "inline"
            ? options?.inlineEdit
            : undefined
        }
      />
    ),
  });
}

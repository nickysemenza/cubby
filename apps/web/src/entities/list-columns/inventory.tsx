import { displayGtin } from "@cubby/schemas/external-id";
import type { inventoryListItemOut } from "@cubby/schemas/inventory";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import type { z } from "zod";

import {
  createCurrencyColumn,
  createEditableAmountColumn,
  createImageColumn,
  createSingleEntityInlineLinkColumn,
  createTimestampColumn,
} from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import {
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { InventoryValuationSummary } from "~/app/_components/locations/inventory-valuation-summary";
import { CategoryLabel } from "~/app/_components/products/CategoryLabel";
import { productCategoryOptionsWithTheme } from "~/app/_components/products/product-category-icons";
import { TableLink } from "~/app/_components/table/TableLink";
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
    entityType: "product",
    entityId: product.id,
  });
  return (
    <EntityInlineLink
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
          add(
            createCurrencyColumn(columnHelper, "valuation", {
              header: "Valuation",
              mobile: { slot: "trailing", priority: 30 },
            }),
          );
          // Last deliberate recount — the only honest freshness signal for a
          // count (`updatedAt` moves on a price-driven valuation recompute).
          add(
            createTimestampColumn(columnHelper, "verifiedAt", {
              header: "Verified",
              className: "w-32",
              mobile: { slot: "meta", priority: 60 },
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
          add(
            createImageColumn(columnHelper, {
              entity: "inventory",
              className: "w-10",
              provenance: relationshipFieldProvenance("inventory", "product"),
            }),
          );
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
                const upc =
                  product.primaryGtin === null
                    ? null
                    : displayGtin(product.primaryGtin);
                return (
                  <Stack gap="xs" className="min-w-0 flex-1">
                    <InventoryProductLink product={product} />
                    {upc && (
                      <div className="text-xs text-muted-foreground">
                        <TableLink
                          to="/usda/upc/$code"
                          params={{ code: upc }}
                          variant="mono"
                        >
                          {upc}
                        </TableLink>
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
                  options: productCategoryOptionsWithTheme,
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
        subject: PRODUCT_SUBJECT,
        initialColumnVisibility: INVENTORY_INITIAL_COLUMN_VISIBILITY,
      }),
      [deletable],
    );

    return {
      overrides,
      compose,
      list,
      useWorkbench: ({ data }) => ({
        contextualStatus: (
          <InventoryValuationSummary items={data} variant="compact" />
        ),
      }),
      wrap: (children, { data }) => (
        <EntityDisplayImagesProvider
          refs={data.flatMap((row) => [
            { entityType: "product" as const, entityId: row.product.id },
            { entityType: "location" as const, entityId: row.location.id },
          ])}
        >
          {children}
        </EntityDisplayImagesProvider>
      ),
    };
  },
});

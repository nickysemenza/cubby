import { displayGtin } from "@cubby/schemas/external-id";
import type {
  InventoryShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import type { inventoryListItemOut } from "@cubby/schemas/inventory";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ImageIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { z } from "zod";
import {
  VerbMenuItem,
  verbBulkAction,
} from "~/app/_components/actions/action-verb-ui";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { Row as FlexRow, Stack } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { NoneValue } from "~/components/ui/none-value";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { multiSelectFilterFn } from "~/entities/filters";
import {
  createCurrencyColumn,
  createEditableAmountColumn,
  createSingleEntityInlineLinkColumn,
  createTimestampColumn,
} from "../_components/data-table/columnHelpers";
import { ListWorkbench } from "../_components/data-table/ListWorkbench";
import { ScopeChip } from "../_components/data-table/ScopeChip";
import {
  SHELF_VIEW_OPTIONS,
  type ShelfView,
} from "../_components/data-table/shelf";
import { EntityInlineLink } from "../_components/EntityInlineLink";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { InventoryDiscardDialog } from "../_components/inventory/inventory-discard-dialog";
import { InventoryShelf } from "../_components/inventory/inventory-shelf";
import { MoveInventoryDialog } from "../_components/inventory/move-inventory-dialog";
import { InventoryValuationSummary } from "../_components/locations/inventory-valuation-summary";
import { CategoryLabel } from "../_components/products/CategoryLabel";
import { productCategoryOptionsWithTheme } from "../_components/products/product-category-icons";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
} from "../_components/products/product-image-summaries";
import { ImageThumbnail } from "../_components/table/ImageThumbnail";
import { TableLink } from "../_components/table/TableLink";

type InventoryListItem = z.infer<typeof inventoryListItemOut>;

const inventoryRoute = getRouteApi("/_authenticated/inventory/");

function InventoryProductImageCell({ productId }: { productId: string }) {
  const images = useHydratedProductImages(productId);
  return (
    <ImageThumbnail
      images={images}
      alt="Image"
      lazyPreview={true}
      entity="inventory"
    />
  );
}

export function InventoryItemList() {
  const inventorySearch = inventoryRoute.useSearch();
  const inventoryNavigate = inventoryRoute.useNavigate();
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<InventoryListItem>(),
    [],
  );
  const {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    preview,
    dockedInspector,
  } = useEntityPreview("inventory", { responsiveInspector: true });
  const [moveTarget, setMoveTarget] = useState<InventoryListItem | null>(null);
  // Discard is single-row only: it writes one ledger line against one product.
  // Held as {productId, entryId} rather than the row, because the dialog
  // deliberately re-fetches the product — a row here knows only its own shelf,
  // and passing that in would read as "this is the whole stock".
  const [discardTarget, setDiscardTarget] = useState<{
    productId: ProductShortcode;
    entryId: InventoryShortcode;
  } | null>(null);
  const [bulkMoveItems, setBulkMoveItems] = useState<InventoryListItem[]>([]);

  const clearProductScope = useCallback(() => {
    void inventoryNavigate({
      search: (prev) => ({ ...prev, productId: undefined }),
      replace: true,
    });
  }, [inventoryNavigate]);
  const clearLocationScope = useCallback(() => {
    void inventoryNavigate({
      search: (prev) => ({ ...prev, locationId: undefined }),
      replace: true,
    });
  }, [inventoryNavigate]);

  const updateMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("inventory", "update"),
    entity: "inventory",
  });

  const extraActions = useCallback(
    (row: InventoryListItem) => (
      <>
        <VerbMenuItem
          verb="moveTo"
          onSelect={(e) => {
            e.stopPropagation();
            setMoveTarget(row);
          }}
        />
        <VerbMenuItem
          verb="discard"
          onSelect={(e) => {
            e.stopPropagation();
            setDiscardTarget({ productId: row.product.id, entryId: row.id });
          }}
        />
      </>
    ),
    [],
  );

  // Its own config rather than the contract default: the dialog says
  // "Inventory Entry", which is what the row IS — the registry label
  // ("Inventory Item") reads as the product on the shelf.
  const deletableConfig = useDeletableConfig({
    mutationFn: entityMutationOptionsFactory("inventory", "delete"),
    entityLabel: "Inventory Entry",
    entity: "inventory",
  });

  const bulkActions = useMemo(
    () => ({
      actions: [
        verbBulkAction<InventoryListItem>("moveTo", {
          id: "move",
          minSelection: 1,
          onExecute: async (rows) => {
            setBulkMoveItems(rows.map((r) => r.original));
            return { success: true };
          },
        }),
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );

  // Memoize columns to prevent recreating on every render.
  // updateMutation is NOT in the dependency array because useMutation returns
  // a new object every render — the closure captures mutateAsync correctly,
  // and it's functionally stable across renders.
  // biome-ignore lint/correctness/useExhaustiveDependencies: updateMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => row.product.id, {
        id: "image",
        header: () => <ImageIcon className="size-3 text-muted-foreground" />,
        enableSorting: false,
        meta: {
          className: "h-px w-10 overflow-hidden px-0 py-0",
          mobile: { slot: "image", priority: -10 },
        },
        cell: (info) => (
          <InventoryProductImageCell productId={info.getValue()} />
        ),
      }),
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
        // Keep the pre-editable click-through to the entry's detail page
        // (same link-in-display pattern as createNameColumn's editable —
        // including the click fence, without which this click would also open
        // the amount editor).
        renderDisplay: (content, row) => (
          <Link
            to={entities.inventory.routes.detail}
            params={entityDetailParams(row.id)}
          >
            {content}
          </Link>
        ),
      }),
      createCurrencyColumn(columnHelper, "valuation", {
        header: "Valuation",
        mobile: { slot: "trailing", priority: 30 },
      }),
      columnHelper.accessor("product", {
        header: "Product",
        enableSorting: false,
        meta: {
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
            <div className="flex items-center gap-2">
              <Stack gap="xs" className="min-w-0 flex-1">
                <EntityInlineLink
                  displayImage={undefined}
                  entity="product"
                  data={product}
                  compact
                />
                {upc && (
                  <div className="text-muted-foreground text-xs">
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
            </div>
          );
        },
      }),
      createSingleEntityInlineLinkColumn(columnHelper, "location", "location", {
        className: "min-w-0 w-40 max-w-56",
        mobile: { slot: "subtitle", priority: 20 },
        filterConfig: { placeholder: "Filter location..." },
        editable: {
          // Not clearable, so newLocationId is never actually null — the
          // fallback only satisfies inventory.update's optional (non-nullable)
          // locationId field.
          onSave: async (newLocationId, row) => {
            await updateMutation.mutateAsync({
              id: row.id,
              data: { locationId: newLocationId ?? undefined },
            });
          },
        },
      }),
      // Product-attribute columns — hidden by default (toggle via the View
      // menu) since the qty/valuation/product/location set covers the common
      // case, but real columns so "show me the Milwaukee stuff" is a header
      // filter, not an agent-only capability (see manufacturerFilter /
      // categoryFilter in inventoryFilterFields).
      columnHelper.accessor((row) => row.product.manufacturer, {
        id: "manufacturer",
        header: "Manufacturer",
        enableSorting: false,
        meta: {
          className: "min-w-0 w-40 truncate",
          mobile: { slot: "meta", priority: 70 },
          filterConfig: { placeholder: "Filter by manufacturer..." },
        },
        cell: (info) => info.getValue() || <NoneValue />,
      }),
      columnHelper.accessor((row) => row.product.category, {
        id: "category",
        header: "Category",
        enableSorting: false,
        filterFn: multiSelectFilterFn,
        meta: {
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
      // Last deliberate recount — the only honest freshness signal for a count
      // (`updatedAt` moves on a price-driven valuation recompute). Dash = never
      // verified; sortable so the oldest bins surface first.
      createTimestampColumn(columnHelper, "verifiedAt", {
        header: "Verified",
        className: "w-32",
        mobile: { slot: "meta", priority: 60 },
      }),
    ],
    [columnHelper],
  );

  // Not `EntityListPage`: this page switches between a table and a shelf view
  // off the same query, so it reads `data` and the workbench's own table,
  // loading state, and delete dialog directly.
  const { workbench, data, totalCount } = useEntityList({
    entity: "inventory",
    // Inventory has custom columns (product image, amount instead of name)
    columns,
    deletable: deletableConfig,
    extraActions,
    bulkActions,
    // "Created" is low-signal when browsing inventory — hidden by default,
    // still toggleable via the View menu.
    initialColumnVisibility: {
      createdAt: false,
      manufacturer: false,
      category: false,
    },
  });
  usePageCount(totalCount);

  const [view, setView] = useState<ShelfView>("table");
  const items = workbench.table.getRowModel().rows.map((r) => r.original);
  const productIds = useMemo(() => data.map((item) => item.product.id), [data]);
  const scopeChips =
    inventorySearch.productId || inventorySearch.locationId ? (
      <FlexRow align="center" gap="sm" wrap>
        {inventorySearch.productId && (
          <ScopeChip
            name="Product"
            value={inventorySearch.productId}
            onClear={clearProductScope}
          />
        )}
        {inventorySearch.locationId && (
          <ScopeChip
            name="Location"
            value={inventorySearch.locationId}
            onClear={clearLocationScope}
          />
        )}
      </FlexRow>
    ) : null;

  return (
    <ProductImageSummariesProvider productIds={productIds}>
      <FlexRow
        align="center"
        justify="between"
        gap="sm"
        className="mb-4 px-2 md:px-6"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {scopeChips}
          {view === "shelf" && (
            <InventoryValuationSummary items={data} variant="compact" />
          )}
        </div>
        <ViewSwitcher
          options={SHELF_VIEW_OPTIONS}
          value={view}
          onValueChange={setView}
        />
      </FlexRow>
      {view === "shelf" ? (
        <div className="px-2 md:px-6">
          <InventoryShelf
            items={items}
            isLoading={workbench.isLoading}
            error={workbench.error}
            infiniteScroll={workbench.infiniteScroll}
          />
        </div>
      ) : (
        <ListWorkbench
          model={workbench}
          contextualStatus={
            <InventoryValuationSummary items={data} variant="compact" />
          }
          ariaLabel="Inventory Items Table"
          onRowClick={onRowClick}
          onRowHover={onRowHover}
          onRowHoverEnd={onRowHoverEnd}
          currentRowId={preview?.id}
          desktopInspector={dockedInspector}
        />
      )}
      <PreviewSheet />
      {view === "shelf" && workbench.deleteDialog}
      {moveTarget && (
        <MoveInventoryDialog
          open={!!moveTarget}
          onOpenChange={(open) => {
            if (!open) setMoveTarget(null);
          }}
          items={[moveTarget]}
          onSuccess={() => setMoveTarget(null)}
        />
      )}
      {discardTarget && (
        <InventoryDiscardDialog
          onOpenChange={(open) => {
            if (!open) setDiscardTarget(null);
          }}
          target={discardTarget}
        />
      )}
      {bulkMoveItems.length > 0 && (
        <MoveInventoryDialog
          open={bulkMoveItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkMoveItems([]);
          }}
          items={bulkMoveItems}
          onSuccess={() => {
            setBulkMoveItems([]);
            workbench.table.resetRowSelection();
          }}
        />
      )}
    </ProductImageSummariesProvider>
  );
}

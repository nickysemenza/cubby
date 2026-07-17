import type { inventoryListItemOut } from "@cubby/schemas/inventory";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { ArrowRightLeft, ImageIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { z } from "zod";
import { Row as FlexRow, Stack } from "~/components/layout";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { useTRPC } from "~/integrations/trpc/react";
import { inventoryMutationInvalidateKeys } from "~/lib/query-keys";
import {
  createCreatedAtColumn,
  createCurrencyColumn,
  createEditableAmountColumn,
  createSingleEntityInlineLinkColumn,
} from "../_components/data-table/columnHelpers";
import {
  ShelfTableToggle,
  type ShelfView,
} from "../_components/data-table/shelf";
import RTable from "../_components/data-table/Table";
import { EntityInlineLink } from "../_components/EntityInlineLink";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { AiSearchBar } from "../_components/inventory/ai-search-bar";
import { InventoryShelf } from "../_components/inventory/inventory-shelf";
import { MoveInventoryDialog } from "../_components/inventory/move-inventory-dialog";
import type { InventoryItem } from "../_components/locations/calculate-inventory-valuation";
import { InventoryValuationSummary } from "../_components/locations/inventory-valuation-summary";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
} from "../_components/products/product-image-summaries";
import { ImageThumbnail } from "../_components/table/ImageThumbnail";
import { TableLink } from "../_components/table/TableLink";

type InventoryListItem = z.infer<typeof inventoryListItemOut>;

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
  const api = useTRPC();
  const columnHelper = useMemo(
    () => createColumnHelper<InventoryListItem>(),
    [],
  );
  const { onRowClick, onRowHover, PreviewSheet } =
    useEntityPreview("inventory");
  const [moveTarget, setMoveTarget] = useState<InventoryListItem | null>(null);
  const [bulkMoveItems, setBulkMoveItems] = useState<InventoryListItem[]>([]);

  const updateMutation = useUpdateMutation({
    mutationFn: api.inventory.update.mutationOptions,
    entity: "inventory",
    invalidateKeys: inventoryMutationInvalidateKeys,
  });

  const extraActions = useCallback(
    (row: InventoryListItem) => (
      <DropdownMenuItem
        onClick={(e) => {
          e.stopPropagation();
          setMoveTarget(row);
        }}
      >
        <ArrowRightLeft className="mr-2 h-4 w-4" />
        Move to...
      </DropdownMenuItem>
    ),
    [],
  );

  // Memoize deletable config to prevent infinite render loop
  const deletableConfig = useDeletableConfig({
    mutationFn: api.inventory.delete.mutationOptions,
    entityLabel: "Inventory Entry",
    invalidateKeys: inventoryMutationInvalidateKeys,
  });

  const bulkActions = useMemo(
    () => ({
      actions: [
        {
          id: "move",
          label: "Move to...",
          icon: <ArrowRightLeft className="h-4 w-4" />,
          minSelection: 1,
          onExecute: async (
            rows: import("@tanstack/react-table").Row<InventoryListItem>[],
          ) => {
            setBulkMoveItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
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
        header: () => <ImageIcon className="h-3 w-3 text-muted-foreground" />,
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
        // (same link-in-display pattern as createNameColumn's editable).
        renderDisplay: (content, row) => (
          <Link to="/inventory/$id" params={{ id: row.id }}>
            {content}
          </Link>
        ),
      }),
      createCurrencyColumn(columnHelper, "valuation", {
        header: "Valuation",
        mobile: { slot: "trailing", priority: 30 },
      }),
      columnHelper.accessor("product", {
        enableSorting: false,
        meta: {
          className: "min-w-0 w-64",
          mobile: { slot: "meta", priority: 50 },
          filterConfig: { placeholder: "Filter product..." },
        },
        cell: (info) => {
          const product = info.getValue();
          const { upc } = product;
          return (
            <div className="flex items-center gap-2">
              <Stack gap="xs" className="min-w-0 flex-1">
                <EntityInlineLink entity="product" data={product} compact />
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
      createCreatedAtColumn(columnHelper),
    ],
    [columnHelper],
  );

  const {
    table,
    data,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
  } = useEntityList({
    entity: "inventory",
    queryOptions: api.inventory.list.queryOptions,
    buildFilters: (ts) => ({
      productNameFilter: ts.getColumnFilter("product"),
      locationNameFilter: ts.getColumnFilter("location"),
    }),
    // Inventory has custom columns (product image, amount instead of name)
    columns,
    filters: ["product", "location"],
    deletable: deletableConfig,
    extraActions,
    bulkActions,
    infinite: true,
    // "Created" is low-signal when browsing inventory — hidden by default,
    // still toggleable via the View menu.
    initialColumnVisibility: {
      createdAt: false,
    },
  });

  const [view, setView] = useState<ShelfView>("table");
  const items = table.getRowModel().rows.map((r) => r.original);
  const productIds = useMemo(() => data.map((item) => item.product.id), [data]);

  return (
    <ProductImageSummariesProvider productIds={productIds}>
      <AiSearchBar table={table} />
      <FlexRow align="center" justify="between" gap="sm" className="mb-4">
        <div className="min-w-0">
          {view === "shelf" && (
            <InventoryValuationSummary
              items={data as InventoryItem[]}
              variant="compact"
            />
          )}
        </div>
        <ShelfTableToggle value={view} onChange={setView} />
      </FlexRow>
      {view === "shelf" ? (
        <InventoryShelf
          items={items}
          isLoading={isLoading}
          error={error}
          infiniteScroll={infiniteScroll}
        />
      ) : (
        <RTable
          table={table}
          additionalToolbarContent={
            <InventoryValuationSummary
              items={data as InventoryItem[]}
              variant="compact"
            />
          }
          isLoading={isLoading}
          error={error}
          ariaLabel="Inventory Items Table"
          timing={timing}
          entity="inventory"
          onRowClick={onRowClick}
          onRowHover={onRowHover}
          bulkActionBar={bulkActionBar}
          infiniteScroll={infiniteScroll}
          refreshControls={refreshControls}
        />
      )}
      <PreviewSheet />
      {deleteDialog}
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
      {bulkMoveItems.length > 0 && (
        <MoveInventoryDialog
          open={bulkMoveItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkMoveItems([]);
          }}
          items={bulkMoveItems}
          onSuccess={() => {
            setBulkMoveItems([]);
            table.resetRowSelection();
          }}
        />
      )}
    </ProductImageSummariesProvider>
  );
}

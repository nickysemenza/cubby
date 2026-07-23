import type { LocationId } from "@cubby/schemas/identifiers";
import type { inventoryListItemOut } from "@cubby/schemas/inventory";
import type { Row } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import { ArrowRightLeft, ImageIcon, Trash } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { z } from "zod";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import { inventoryMutationInvalidateKeys } from "~/lib/query-keys";
import {
  createEditableAmountColumn,
  createSingleEntityInlineLinkColumn,
} from "../data-table/columnHelpers";
import type { ShelfView } from "../data-table/shelf";
import RTable from "../data-table/Table";
import { useEntityList } from "../hooks/useEntityList";
import { useUpdateMutation } from "../hooks/useUpdateMutation";
import { DeleteInventoryDialog } from "../inventory/delete-inventory-dialog";
import { InventoryShelf } from "../inventory/inventory-shelf";
import { MoveInventoryDialog } from "../inventory/move-inventory-dialog";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
} from "../products/product-image-summaries";
import { useProductUnitMappingSummaries } from "../products/product-unit-mapping-summaries";
import { ImageThumbnail } from "../table/ImageThumbnail";

type InventoryItem = z.infer<typeof inventoryListItemOut>;

/**
 * The location-scoped inventory.list input. Shared with LocationContents so
 * its header valuation/count reads hit the SAME React Query cache entry as
 * this table's list — one fetch serves both.
 */
export const locationInventoryListInput = (locationId: LocationId) =>
  ({
    sort: { orderBy: "createdAt", direction: "desc" },
    pagination: { pageIndex: 0, pageSize: 100 },
    filters: { locationIdFilter: locationId },
  }) as const;

interface LocationInventoryTableProps {
  locationId: LocationId;
  /** Shelf/table switch — owned by the parent (LocationContents) toolbar. */
  view: ShelfView;
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

export function LocationInventoryTable({
  locationId,
  view,
}: LocationInventoryTableProps) {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<InventoryItem>(), []);
  const [unitMappingProductIds, setUnitMappingProductIds] = useState<string[]>(
    [],
  );
  const unitMappingsByProductId = useProductUnitMappingSummaries(
    unitMappingProductIds,
  );
  const updateMutation = useUpdateMutation({
    mutationFn: api.inventory.update.mutationOptions,
    entity: "inventory",
    invalidateKeys: inventoryMutationInvalidateKeys,
  });

  // Dialog states for bulk actions
  const [dialogState, setDialogState] = useState<{
    type: "move" | "delete" | null;
    items: InventoryItem[];
  }>({ type: null, items: [] });

  const bulkActions = useMemo(
    () => ({
      actions: [
        {
          id: "move",
          label: "Move",
          icon: <ArrowRightLeft className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<InventoryItem>[]) => {
            setDialogState({
              type: "move",
              items: rows.map((r) => r.original),
            });
            return { success: true };
          },
        },
        {
          id: "delete",
          label: "Delete",
          icon: <Trash className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<InventoryItem>[]) => {
            setDialogState({
              type: "delete",
              items: rows.map((r) => r.original),
            });
            return { success: true };
          },
        },
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );

  // Memoize columns to prevent recreating on every render. updateMutation is
  // NOT in the dependency array because useMutation returns a new object
  // every render, but the closure captures mutateAsync correctly and it's
  // functionally stable — see productlist.tsx for the same pattern.
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

      createSingleEntityInlineLinkColumn(columnHelper, "product", "product", {
        header: "Product",
        className: "min-w-0 w-64",
      }),

      createEditableAmountColumn(columnHelper, "amount", {
        onSave: async (newAmount, row) => {
          await updateMutation.mutateAsync({
            id: row.id,
            data: { amount: newAmount },
          });
        },
        getUnitMappings: (row) => unitMappingsByProductId[row.product.id] ?? [],
      }),
    ],
    [columnHelper, unitMappingsByProductId],
  );

  const { table, data, isLoading, error, bulkActionBar } = useEntityList<
    InventoryItem,
    Record<string, never>
  >({
    entity: "inventory",
    queryOptions: () =>
      api.inventory.list.queryOptions(locationInventoryListInput(locationId)),
    buildFilters: () => ({}),
    filters: [],
    columns,
    extraActions: (item) => (
      <>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDialogState({ type: "move", items: [item] })}
        >
          <ArrowRightLeft className="mr-2 size-4" />
          Move to...
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={() => setDialogState({ type: "delete", items: [item] })}
        >
          <Trash className="mr-2 size-4" />
          Delete
        </Button>
      </>
    ),
    bulkActions,
  });

  const items = table.getRowModel().rows.map((r) => r.original);
  const productIds = useMemo(() => data.map((item) => item.product.id), [data]);

  useEffect(() => {
    setUnitMappingProductIds((current) =>
      sameIds(current, productIds) ? current : productIds,
    );
  }, [productIds]);

  return (
    <ProductImageSummariesProvider productIds={productIds}>
      {view === "shelf" ? (
        <InventoryShelf items={items} isLoading={isLoading} error={error} />
      ) : (
        <RTable
          table={table}
          isLoading={isLoading}
          error={error}
          entity="inventory"
          bulkActionBar={bulkActionBar}
          embedded
        />
      )}

      {/* Move dialog */}
      <MoveInventoryDialog
        open={dialogState.type === "move"}
        onOpenChange={(open) => {
          if (!open) setDialogState({ type: null, items: [] });
        }}
        items={dialogState.items}
        sourceLocationId={locationId}
        onSuccess={() => {
          setDialogState({ type: null, items: [] });
          table.resetRowSelection();
        }}
      />

      {/* Delete dialog */}
      <DeleteInventoryDialog
        open={dialogState.type === "delete"}
        onOpenChange={(open) => {
          if (!open) setDialogState({ type: null, items: [] });
        }}
        items={dialogState.items}
        onSuccess={() => {
          setDialogState({ type: null, items: [] });
          table.resetRowSelection();
        }}
      />
    </ProductImageSummariesProvider>
  );
}

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

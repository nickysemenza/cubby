import type { LocationId } from "@cubby/schemas/identifiers";
import type { inventoryListItemOut } from "@cubby/schemas/inventory-responses";
import type { Row } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import { ArrowRightLeft, ImageIcon, Trash } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { z } from "zod";
import { Button } from "~/components/ui/button";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";
import {
  createEditableAmountColumn,
  createSingleEntityPillColumn,
} from "../data-table/columnHelpers";
import { ShelfTableToggle, type ShelfView } from "../data-table/shelf";
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
import {
  type ProductUnitMappingMap,
  useProductUnitMappingSummaries,
} from "../products/product-unit-mapping-summaries";
import { ImageThumbnail } from "../table/ImageThumbnail";

type InventoryItem = z.infer<typeof inventoryListItemOut>;

interface LocationInventoryTableProps {
  locationId: LocationId;
}

export function LocationInventoryTable({
  locationId,
}: LocationInventoryTableProps) {
  const api = useTRPC();
  const columnHelper = createColumnHelper<InventoryItem>();
  const unitMappingSummariesRef = useRef<ProductUnitMappingMap>({});
  const updateMutation = useUpdateMutation({
    mutationFn: api.inventory.update.mutationOptions,
    entity: "inventory",
    invalidateKeys: [queryKeys.inventory.list],
  });

  // Browse as a photo "shelf" by default; the editable table is one toggle away.
  const [view, setView] = useState<ShelfView>("shelf");

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
          icon: <ArrowRightLeft className="h-4 w-4" />,
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
          icon: <Trash className="h-4 w-4" />,
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

  const { table, isLoading, error, bulkActionBar } = useEntityList<
    InventoryItem,
    Record<string, never>
  >({
    entity: "inventory",
    queryOptions: () =>
      api.inventory.list.queryOptions({
        sort: { orderBy: "createdAt", direction: "desc" },
        pagination: { pageIndex: 0, pageSize: 100 },
        filters: { locationIdFilter: locationId },
      }),
    buildFilters: () => ({}),
    filters: [],
    columns: [
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

      createSingleEntityPillColumn(columnHelper, "product", "product", {
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
        getUnitMappings: (row) =>
          unitMappingSummariesRef.current[row.product.id] ?? [],
      }),
    ],
    extraActions: (item) => (
      <>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDialogState({ type: "move", items: [item] })}
        >
          <ArrowRightLeft className="mr-2 h-4 w-4" />
          Move to...
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={() => setDialogState({ type: "delete", items: [item] })}
        >
          <Trash className="mr-2 h-4 w-4" />
          Delete
        </Button>
      </>
    ),
    bulkActions,
  });

  const items = table.getRowModel().rows.map((r) => r.original);
  const productIds = items.map((item) => item.product.id);
  const unitMappingSummaries = useProductUnitMappingSummaries(productIds);
  unitMappingSummariesRef.current = unitMappingSummaries;

  return (
    <ProductImageSummariesProvider productIds={productIds}>
      <ShelfTableToggle
        value={view}
        onChange={setView}
        className="mb-4 justify-end"
      />

      {view === "shelf" ? (
        <InventoryShelf items={items} isLoading={isLoading} error={error} />
      ) : (
        <RTable
          table={table}
          isLoading={isLoading}
          error={error}
          entity="inventory"
          bulkActionBar={bulkActionBar}
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

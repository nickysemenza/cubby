import { createColumnHelper } from "@tanstack/react-table";
import { ArrowRightLeft, Trash } from "lucide-react";
import { useState } from "react";
import type { z } from "zod";
import { Button } from "~/components/ui/button";
import { queryKeys } from "~/lib/query-keys";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import type { LocationId } from "~/schemas/identifiers";
import { useTRPC } from "~/trpc/react";
import {
  createEditableAmountColumn,
  createImageColumn,
  createSingleEntityPillColumn,
} from "../data-table/columnHelpers";
import RTable from "../data-table/Table";
import { useEntityList } from "../hooks/useEntityList";
import { DeleteInventoryDialog } from "../inventory/delete-inventory-dialog";
import { MoveInventoryDialog } from "../inventory/move-inventory-dialog";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface LocationInventoryTableProps {
  locationId: LocationId;
}

export function LocationInventoryTable({
  locationId,
}: LocationInventoryTableProps) {
  const api = useTRPC();
  const columnHelper = createColumnHelper<InventoryItem>();

  // Dialog states for bulk actions
  const [dialogState, setDialogState] = useState<{
    type: "move" | "delete" | null;
    items: InventoryItem[];
  }>({ type: null, items: [] });

  const { table, data, isLoading, error } = useEntityList({
    entity: "inventory",
    queryOptions: () =>
      api.inventory.list.queryOptions({
        sort: { orderBy: "createdAt", direction: "desc" },
        pagination: { pageIndex: 0, pageSize: 100 },
        filters: { locationIdFilter: locationId },
      }),
    buildFilters: () => ({}),
    columns: [
      createImageColumn(columnHelper, {
        getImages: (row) => row.product.images,
      }),

      createSingleEntityPillColumn(columnHelper, "product", "product", {
        header: "Product",
      }),

      createEditableAmountColumn(columnHelper, "amount", {
        onSave: async (newAmount, row) => {
          await api.inventory.update.mutate({
            id: row.id,
            data: { amount: newAmount },
          });
        },
        getUnitMappings: (row) => row.product.unitMappings,
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
    deletable: false, // We use custom delete dialog
    customQueryKey: [
      queryKeys.inventory.list,
      { locationIdFilter: locationId },
    ],
  });

  // Get selected items for bulk actions
  const selectedItems = Object.keys(table.getState().rowSelection)
    .filter((id) => table.getState().rowSelection[id])
    .map((id) => data.items.find((item) => item.id === id))
    .filter((item): item is InventoryItem => item !== undefined);

  // Custom bulk action bar
  const customBulkActionBar = selectedItems.length > 0 && (
    <div className="flex items-center gap-2">
      <span className="text-sm">
        {selectedItems.length} item{selectedItems.length !== 1 ? "s" : ""}{" "}
        selected
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setDialogState({ type: "move", items: selectedItems })}
      >
        <ArrowRightLeft className="mr-2 h-4 w-4" />
        Move
      </Button>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => setDialogState({ type: "delete", items: selectedItems })}
      >
        <Trash className="mr-2 h-4 w-4" />
        Delete
      </Button>
    </div>
  );

  return (
    <>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        entity="inventory"
        bulkActionBar={customBulkActionBar}
      />

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
    </>
  );
}

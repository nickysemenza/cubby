import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import type { LocationId } from "@cubby/schemas/identifiers";
import type { Row } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import { ArrowRightLeft, Trash } from "lucide-react";
import { useMemo, useState } from "react";
import type { z } from "zod";
import { Button } from "~/components/ui/button";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";
import {
  createEditableAmountColumn,
  createImageColumn,
  createSingleEntityPillColumn,
} from "../data-table/columnHelpers";
import RTable from "../data-table/Table";
import { useEntityList } from "../hooks/useEntityList";
import { useUpdateMutation } from "../hooks/useUpdateMutation";
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
  const updateMutation = useUpdateMutation({
    mutationFn: api.inventory.update.mutationOptions,
    entity: "inventory",
    invalidateKeys: [queryKeys.inventory.list],
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
      createImageColumn(columnHelper, {
        getImages: (row) => row.product.images,
        entity: "inventory",
      }),

      createSingleEntityPillColumn(columnHelper, "product", "product", {
        header: "Product",
      }),

      createEditableAmountColumn(columnHelper, "amount", {
        onSave: async (newAmount, row) => {
          await updateMutation.mutateAsync({
            id: row.id,
            data: { amount: newAmount },
          });
        },
        getUnitMappings: (row) =>
          row.product.unitMappings.map((m) => ({
            a: m.a,
            b: m.b,
            source: m.source,
            sourceMetadata: m.sourceMetadata ?? {
              type: "product",
              productId: row.product.id,
            },
          })),
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

  return (
    <>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        entity="inventory"
        bulkActionBar={bulkActionBar}
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

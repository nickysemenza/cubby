import { useMutation } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  type RowSelectionState,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowRightLeft,
  Check,
  MoreHorizontal,
  Pencil,
  Trash,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import type { LocationId } from "~/schemas/identifiers";
import { useTRPC } from "~/trpc/react";
import { buildSelectColumn } from "../data-table/row-selection";
import { EntityPillLink } from "../EntityPill";
import { DeleteInventoryDialog } from "../inventory/delete-inventory-dialog";
import { showAmountAndPrice } from "../inventory/format-amount";
import { MoveInventoryDialog } from "../inventory/move-inventory-dialog";
import { NoneState } from "../NoneState";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface LocationInventoryTableProps {
  locationId: LocationId;
  inventoryItems: InventoryItem[];
  onRefresh: () => void;
}

export function LocationInventoryTable({
  locationId,
  inventoryItems,
  onRefresh,
}: LocationInventoryTableProps) {
  const api = useTRPC();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editingAmount, setEditingAmount] = useState<{
    value: number;
    unit: string;
  }>({ value: 0, unit: "" });

  // Dialog states
  const [dialogState, setDialogState] = useState<{
    type: "move" | "delete" | null;
    items: InventoryItem[];
  }>({ type: null, items: [] });

  // Update mutation for inline editing
  const updateMutation = useMutation(
    api.inventoryItem.update.mutationOptions({
      onSuccess: () => {
        toast.success("Amount updated");
        setEditingRowId(null);
        onRefresh();
      },
      onError: (err) => {
        toast.error(err.message || "Failed to update");
      },
    }),
  );

  const columnHelper = createColumnHelper<InventoryItem>();

  const columns = useMemo(
    () => [
      buildSelectColumn<InventoryItem>(),

      columnHelper.accessor("product", {
        header: "Product",
        cell: (info) => {
          const product = info.getValue();
          return (
            <div className="space-y-0.5">
              <EntityPillLink entity="product" data={product} />
            </div>
          );
        },
      }),

      columnHelper.accessor("amount", {
        header: "Amount",
        cell: (info) => {
          const item = info.row.original;
          const isEditing = editingRowId === item.id;

          if (isEditing) {
            return (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  value={editingAmount.value}
                  onChange={(e) =>
                    setEditingAmount((prev) => ({
                      ...prev,
                      value: parseFloat(e.target.value) || 0,
                    }))
                  }
                  className="w-20"
                  step="any"
                  autoFocus
                />
                <Input
                  type="text"
                  value={editingAmount.unit}
                  onChange={(e) =>
                    setEditingAmount((prev) => ({
                      ...prev,
                      unit: e.target.value,
                    }))
                  }
                  className="w-20"
                  placeholder="unit"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    updateMutation.mutate({
                      id: item.id,
                      data: { amount: editingAmount },
                    });
                  }}
                  disabled={updateMutation.isPending}
                >
                  <Check className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setEditingRowId(null)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            );
          }

          return (
            <button
              type="button"
              className="flex items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted"
              onClick={() => {
                setEditingRowId(item.id);
                setEditingAmount(item.amount);
              }}
            >
              {showAmountAndPrice(info.getValue(), item.product.unitMappings)}
              <Pencil className="ml-1 h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
            </button>
          );
        },
      }),

      columnHelper.display({
        id: "actions",
        header: "",
        cell: (info) => {
          const item = info.row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon" />}
              >
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() =>
                    setDialogState({ type: "move", items: [item] })
                  }
                >
                  <ArrowRightLeft className="mr-2 h-4 w-4" />
                  Move to...
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() =>
                    setDialogState({ type: "delete", items: [item] })
                  }
                >
                  <Trash className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      }),
    ],
    [columnHelper, editingRowId, editingAmount, updateMutation],
  );

  const table = useReactTable({
    data: inventoryItems,
    columns,
    getCoreRowModel: getCoreRowModel(),
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    state: { rowSelection },
    getRowId: (row) => row.id,
  });

  // Get selected items
  const selectedItems = useMemo(() => {
    const selectedIds = Object.keys(rowSelection).filter(
      (id) => rowSelection[id],
    );
    return inventoryItems.filter((item) => selectedIds.includes(item.id));
  }, [rowSelection, inventoryItems]);

  const handleBulkMove = () => {
    setDialogState({ type: "move", items: selectedItems });
  };

  const handleBulkDelete = () => {
    setDialogState({ type: "delete", items: selectedItems });
  };

  const clearSelection = () => {
    setRowSelection({});
  };

  const handleDialogSuccess = () => {
    clearSelection();
    onRefresh();
  };

  if (inventoryItems.length === 0) {
    return <NoneState />;
  }

  return (
    <div className="space-y-2">
      {/* Bulk actions bar */}
      {selectedItems.length > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-muted p-3">
          <span className="font-medium text-sm">
            {selectedItems.length} item{selectedItems.length !== 1 ? "s" : ""}{" "}
            selected
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleBulkMove}>
              <ArrowRightLeft className="mr-2 h-4 w-4" />
              Move
            </Button>
            <Button variant="destructive" size="sm" onClick={handleBulkDelete}>
              <Trash className="mr-2 h-4 w-4" />
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() && "selected"}
                className="group"
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Move dialog */}
      <MoveInventoryDialog
        open={dialogState.type === "move"}
        onOpenChange={(open) => {
          if (!open) setDialogState({ type: null, items: [] });
        }}
        items={dialogState.items}
        sourceLocationId={locationId}
        onSuccess={handleDialogSuccess}
      />

      {/* Delete dialog */}
      <DeleteInventoryDialog
        open={dialogState.type === "delete"}
        onOpenChange={(open) => {
          if (!open) setDialogState({ type: null, items: [] });
        }}
        items={dialogState.items}
        onSuccess={handleDialogSuccess}
      />
    </div>
  );
}

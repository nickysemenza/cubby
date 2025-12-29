import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
  Eye,
  MoreHorizontal,
  Package,
  Pencil,
  Trash,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { MobileCard } from "~/components/entity/mobile-card";
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
import { createActionsColumn } from "../data-table/columnHelpers";
import { MobileCardView } from "../data-table/MobileCardView";
import { buildSelectColumn } from "../data-table/row-selection";
import { EntityPillLink } from "../EntityPill";
import { DeleteInventoryDialog } from "../inventory/delete-inventory-dialog";
import { showAmountAndPrice } from "../inventory/format-amount";
import { MoveInventoryDialog } from "../inventory/move-inventory-dialog";
import { NoneState } from "../NoneState";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

/** Editable amount cell - used in both desktop table and mobile cards */
const EditableAmountCell: React.FC<{
  item: InventoryItem;
  isEditing: boolean;
  editingAmount: { value: number; unit: string };
  setEditingAmount: React.Dispatch<
    React.SetStateAction<{ value: number; unit: string }>
  >;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  isPending: boolean;
  variant: "desktop" | "mobile";
}> = ({
  item,
  isEditing,
  editingAmount,
  setEditingAmount,
  onStartEdit,
  onSave,
  onCancel,
  isPending,
  variant,
}) => {
  const isMobile = variant === "mobile";
  const inputClass = isMobile ? "h-8 w-20" : "w-20";
  const buttonClass = isMobile ? "h-8 w-8" : undefined;

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
          className={inputClass}
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
          className={inputClass}
          placeholder="unit"
        />
        <Button
          size="icon"
          variant="ghost"
          className={buttonClass}
          onClick={onSave}
          disabled={isPending}
        >
          <Check className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={buttonClass}
          onClick={onCancel}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  // Display mode
  if (isMobile) {
    return (
      <button
        type="button"
        className="flex min-h-[44px] items-center gap-1 rounded-md bg-muted/50 px-3 py-2 text-left transition-colors hover:bg-muted"
        onClick={onStartEdit}
      >
        <span className="text-sm">
          {showAmountAndPrice(item.amount, item.product.unitMappings)}
        </span>
        <Pencil className="ml-2 h-3 w-3 text-muted-foreground" />
      </button>
    );
  }

  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted"
      onClick={onStartEdit}
    >
      {showAmountAndPrice(item.amount, item.product.unitMappings)}
      <Pencil className="ml-1 h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
    </button>
  );
};

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
          return (
            <EditableAmountCell
              item={item}
              isEditing={editingRowId === item.id}
              editingAmount={editingAmount}
              setEditingAmount={setEditingAmount}
              onStartEdit={() => {
                setEditingRowId(item.id);
                setEditingAmount(item.amount);
              }}
              onSave={() => {
                updateMutation.mutate({
                  id: item.id,
                  data: { amount: editingAmount },
                });
              }}
              onCancel={() => setEditingRowId(null)}
              isPending={updateMutation.isPending}
              variant="desktop"
            />
          );
        },
      }),

      createActionsColumn(columnHelper, "inventory-item", {
        extraActions: (item) => (
          <>
            <DropdownMenuItem
              onClick={() => setDialogState({ type: "move", items: [item] })}
            >
              <ArrowRightLeft className="mr-2 h-4 w-4" />
              Move to...
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setDialogState({ type: "delete", items: [item] })}
            >
              <Trash className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </>
        ),
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

      {/* Desktop Table */}
      <div className="hidden rounded-md border lg:block">
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

      {/* Mobile Card View */}
      <MobileCardView
        table={table}
        renderMobileCard={(row) => {
          const item = row.original;
          const isSelected = rowSelection[item.id] ?? false;

          const actionsDropdown = (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                  />
                }
              >
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  render={<Link to="/inventory/$id" params={{ id: item.id }} />}
                >
                  <Eye className="mr-2 h-4 w-4" />
                  View Details
                </DropdownMenuItem>
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

          return (
            <MobileCard
              selectable={{
                isSelected,
                onSelectionChange: (checked) => {
                  setRowSelection((prev) => ({
                    ...prev,
                    [item.id]: checked,
                  }));
                },
              }}
              actions={actionsDropdown}
            >
              <div className="space-y-2">
                {/* Product name */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">
                      {item.product.name}
                    </span>
                  </div>
                  {item.product.manufacturer && (
                    <p className="ml-6 truncate text-muted-foreground text-sm">
                      {item.product.manufacturer}
                    </p>
                  )}
                </div>

                {/* Amount - editable */}
                <EditableAmountCell
                  item={item}
                  isEditing={editingRowId === item.id}
                  editingAmount={editingAmount}
                  setEditingAmount={setEditingAmount}
                  onStartEdit={() => {
                    setEditingRowId(item.id);
                    setEditingAmount(item.amount);
                  }}
                  onSave={() => {
                    updateMutation.mutate({
                      id: item.id,
                      data: { amount: editingAmount },
                    });
                  }}
                  onCancel={() => setEditingRowId(null)}
                  isPending={updateMutation.isPending}
                  variant="mobile"
                />
              </div>
            </MobileCard>
          );
        }}
      />

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

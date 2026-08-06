import type { InventoryShortcode } from "@cubby/schemas/identifiers";
import type { ProductWithFoodOut } from "@cubby/schemas/product";
import { Link } from "@tanstack/react-router";
import type { Row } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { ArrowRightLeft, PackageMinus, Trash } from "lucide-react";
import { type FC, useMemo, useState } from "react";
import {
  createCurrencyColumn,
  createEditableAmountColumn,
  createSingleEntityInlineLinkColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { useClientEntityList } from "~/app/_components/hooks/useClientEntityList";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { DeleteInventoryDialog } from "~/app/_components/inventory/delete-inventory-dialog";
import { MoveInventoryDialog } from "~/app/_components/inventory/move-inventory-dialog";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { useTRPC } from "~/integrations/trpc/react";
import { inventoryMutationInvalidateKeys } from "~/lib/query-keys";
import { ShelfEmpty } from "../data-table/shelf";
import { ProductDiscardDialog } from "./product-discard-dialog";

type InventoryEntry = ProductWithFoodOut["inventoryEntry"][number];
/** `useClientEntityList` keys rows by `id`; inventory entries carry no name. */
type StockedRow = InventoryEntry & { product: { name: string } };

/** Stable hook config (see apps/web/CLAUDE.md on inline objects). */
const EMBEDDED_TABLE_STATE = {
  urlSync: false,
  readUrlState: false,
} as const;

type DialogState =
  | { type: null }
  | { type: "move" | "delete"; items: StockedRow[] }
  | { type: "discard"; entryId: InventoryShortcode };

const CLOSED: DialogState = { type: null };

/** Product inventory rows: location and amount are direct, editable entry fields. */
export const ProductStockedAt: FC<{ product: ProductWithFoodOut }> = ({
  product,
}) => {
  const api = useTRPC();
  const helper = useMemo(() => createColumnHelper<StockedRow>(), []);
  const [dialog, setDialog] = useState<DialogState>(CLOSED);
  const update = useUpdateMutation({
    mutationFn: api.inventory.update.mutationOptions,
    entity: "inventory",
    invalidateKeys: inventoryMutationInvalidateKeys,
  });

  // The shared Move/Delete dialogs name a row by its product; on this page the
  // product is the page itself, so carry it onto the row rather than refetching
  // the list-shaped inventory row.
  const rows = useMemo<StockedRow[]>(
    () =>
      product.inventoryEntry.map((entry) => ({
        ...entry,
        product: { name: product.name },
      })),
    [product.inventoryEntry, product.name],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: mutation wrapper is functionally stable
  const columns = useMemo(
    () => [
      createSingleEntityInlineLinkColumn(helper, "location", "location", {
        header: "Location",
        className: "w-56",
        editable: {
          onSave: async (locationId, entry) => {
            if (!locationId) return;
            await update.mutateAsync({ id: entry.id, data: { locationId } });
          },
        },
      }),
      createEditableAmountColumn(helper, "amount", {
        onSave: async (amount, entry) => {
          await update.mutateAsync({ id: entry.id, data: { amount } });
        },
        getUnitMappings: () => product.unitMappings,
        // The row's own entity — every other column here points at the
        // location or the product. Same treatment as the location table.
        renderDisplay: (content, entry) => (
          <Link to="/inventory/$shortcode" params={{ shortcode: entry.id }}>
            {content}
          </Link>
        ),
      }),
      createCurrencyColumn(helper, "valuation", {
        header: "Value",
        className: "w-24",
      }),
      helper.accessor("verifiedAt", {
        header: "Verified",
        meta: { className: "w-32" },
        cell: (info) =>
          info.getValue()
            ? formatDistanceToNow(info.getValue()!, { addSuffix: true })
            : "—",
      }),
    ],
    [helper, product.unitMappings],
  );

  const bulkActions = useMemo(
    () => ({
      actions: [
        {
          id: "move",
          label: "Move",
          icon: <ArrowRightLeft className="size-4" />,
          minSelection: 1,
          onExecute: async (selected: Row<StockedRow>[]) => {
            setDialog({ type: "move", items: selected.map((r) => r.original) });
            return { success: true };
          },
        },
        {
          id: "delete",
          label: "Delete",
          icon: <Trash className="size-4" />,
          minSelection: 1,
          onExecute: async (selected: Row<StockedRow>[]) => {
            setDialog({
              type: "delete",
              items: selected.map((r) => r.original),
            });
            return { success: true };
          },
        },
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );

  const { table, bulkActionBar } = useClientEntityList<StockedRow>({
    entity: "inventory",
    data: rows,
    columns,
    tableStateOptions: EMBEDDED_TABLE_STATE,
    // Distinct column set from the /inventory index, so it needs its own
    // persisted View settings rather than sharing `table-columns:inventory`.
    columnVisibilityScope: "product-detail",
    bulkActions,
    extraActions: (entry) => (
      <>
        <DropdownMenuItem
          onClick={(event) => {
            event.stopPropagation();
            setDialog({ type: "move", items: [entry] });
          }}
        >
          <ArrowRightLeft />
          Move to...
        </DropdownMenuItem>
        {/* Discard writes a ledger row and can clear the shelf in the same
            transaction — the honest verb for "used it up", where Delete just
            says the entry should never have existed. */}
        <DropdownMenuItem
          onClick={(event) => {
            event.stopPropagation();
            setDialog({ type: "discard", entryId: entry.id });
          }}
        >
          <PackageMinus />
          Discard...
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={(event) => {
            event.stopPropagation();
            setDialog({ type: "delete", items: [entry] });
          }}
        >
          <Trash />
          Delete
        </DropdownMenuItem>
      </>
    ),
  });

  if (product.inventoryEntry.length === 0) {
    return <ShelfEmpty entity="inventory" label="Not stocked anywhere" />;
  }

  const closeAndClear = () => {
    setDialog(CLOSED);
    table.resetRowSelection();
  };

  return (
    <>
      <RTable
        table={table}
        ariaLabel={`${product.name} inventory`}
        entity="inventory"
        sizingKey="inventory:product-detail"
        bulkActionBar={bulkActionBar}
        embedded
      />

      <MoveInventoryDialog
        open={dialog.type === "move"}
        onOpenChange={(open) => {
          if (!open) setDialog(CLOSED);
        }}
        items={dialog.type === "move" ? dialog.items : []}
        onSuccess={closeAndClear}
      />

      <DeleteInventoryDialog
        open={dialog.type === "delete"}
        onOpenChange={(open) => {
          if (!open) setDialog(CLOSED);
        }}
        items={dialog.type === "delete" ? dialog.items : []}
        onSuccess={closeAndClear}
      />

      {/* Keyed so a second row's Discard remounts the form with its own shelf
          preselected (see `defaultInventoryEntryId`). */}
      <ProductDiscardDialog
        key={dialog.type === "discard" ? dialog.entryId : "discard"}
        open={dialog.type === "discard"}
        onOpenChange={(open) => {
          if (!open) setDialog(CLOSED);
        }}
        product={product}
        defaultInventoryEntryId={
          dialog.type === "discard" ? dialog.entryId : undefined
        }
      />
    </>
  );
};

import type { ProductWithFoodOut } from "@cubby/schemas/product";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { type FC, useMemo } from "react";
import {
  createCurrencyColumn,
  createEditableAmountColumn,
  createSingleEntityInlineLinkColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { useTRPC } from "~/integrations/trpc/react";
import { inventoryMutationInvalidateKeys } from "~/lib/query-keys";
import { ShelfEmpty } from "../data-table/shelf";

type InventoryEntry = ProductWithFoodOut["inventoryEntry"][number];

/** Product inventory rows: location and amount are direct, editable entry fields. */
export const ProductStockedAt: FC<{ product: ProductWithFoodOut }> = ({
  product,
}) => {
  const api = useTRPC();
  const helper = useMemo(() => createColumnHelper<InventoryEntry>(), []);
  const update = useUpdateMutation({
    mutationFn: api.inventory.update.mutationOptions,
    entity: "inventory",
    invalidateKeys: inventoryMutationInvalidateKeys,
  });
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
  const table = useReactTable({
    data: product.inventoryEntry,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (entry) => entry.id,
  });

  if (product.inventoryEntry.length === 0) {
    return <ShelfEmpty entity="inventory" label="Not stocked anywhere" />;
  }
  return (
    <RTable table={table} ariaLabel={`${product.name} inventory`} embedded />
  );
};

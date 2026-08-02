import type { PurchaseFilters, PurchaseOut } from "@cubby/schemas/purchase";
import type { VendorOut } from "@cubby/schemas/vendor";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import {
  createCurrencyColumn,
  createPlainDateColumn,
  createTextColumn,
} from "~/app/_components/data-table/columnHelpers";
import { EditableCell } from "~/app/_components/data-table/editable-cell";
import RTable from "~/app/_components/data-table/Table";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";

const EMBEDDED_TABLE_STATE = {
  initialSort: "date",
  urlSync: false,
  readUrlState: false,
  syncPaginationToUrl: false,
} as const;

/**
 * Server-backed purchase roster scoped to one vendor. Related Expense and
 * Financial transaction columns come from the shared graph-preview registry,
 * so this table and the global Purchase list render and filter them identically.
 */
export function VendorPurchasesTable({ vendor }: { vendor: VendorOut }) {
  const api = useTRPC();
  const helper = useMemo(() => createColumnHelper<PurchaseOut>(), []);
  const scope = useMemo<Partial<PurchaseFilters>>(
    () => ({ vendorId: vendor.id }),
    [vendor.id],
  );
  const update = useUpdateMutation({
    mutationFn: api.purchase.update.mutationOptions,
    entity: "purchase",
    invalidateKeys: purchaseMutationInvalidateKeys,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: mutation wrapper is functionally stable
  const columns = useMemo(
    () => [
      createPlainDateColumn(helper, "date", {
        header: "Date",
        editable: {
          onSave: async (date, purchase) => {
            if (date === null) return;
            await update.mutateAsync({ id: purchase.id, data: { date } });
          },
        },
      }),
      helper.display({
        id: "purchase",
        header: "Purchase",
        meta: { className: "w-56" },
        cell: (info) => (
          <EntityInlineLink entity="purchase" data={info.row.original} />
        ),
      }),
      createTextColumn(helper, "orderId", {
        header: "Order #",
        className: "w-32 font-mono",
        editable: {
          onSave: async (orderId, purchase) => {
            await update.mutateAsync({ id: purchase.id, data: { orderId } });
          },
        },
      }),
      helper.accessor("expenseCount", {
        header: "Expense count",
        meta: { numeric: true, className: "w-24" },
      }),
      // Paperwork total is a per-order reconciliation cue, never spend; do
      // not use createCurrencyColumn because that factory renders a sum footer.
      helper.accessor("statedTotal", {
        header: "Stated",
        meta: { numeric: true, className: "w-24" },
        cell: (info) => (
          <EditableCell
            value={info.getValue()}
            config={{ type: "currency" }}
            onSave={async (statedTotal) => {
              const purchase = info.row.original;
              await update.mutateAsync({
                id: purchase.id,
                data: { statedTotal },
              });
            }}
            renderValue={(statedTotal) =>
              statedTotal == null ? <NoneValue /> : formatCurrency(statedTotal)
            }
          />
        ),
      }),
      createCurrencyColumn(helper, "expenseTotal", {
        header: "Expense total",
        className: "w-28",
        zeroAsEmpty: false,
      }),
    ],
    [helper],
  );
  const list = useEntityList<PurchaseOut, PurchaseFilters>({
    entity: "purchase",
    queryOptions: api.purchase.list.queryOptions,
    scopeFilters: scope,
    columns,
    tableStateOptions: EMBEDDED_TABLE_STATE,
    columnVisibilityScope: "vendor-detail",
    hiddenFilterColumns: ["vendor"],
  });

  if (!list.isLoading && list.data.length === 0) return <NoneValue />;
  return (
    <RTable
      table={list.table}
      isLoading={list.isLoading}
      error={list.error}
      timing={list.timing}
      sizingKey="purchase:vendor-detail"
      ariaLabel={`${vendor.name} purchases`}
      embedded
      showColumnMenu
      infiniteScroll={list.infiniteScroll}
      refreshControls={list.refreshControls}
    />
  );
}

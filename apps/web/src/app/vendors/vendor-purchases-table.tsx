import type { PurchaseFilters, PurchaseOut } from "@cubby/schemas/purchase";
import type { VendorOut } from "@cubby/schemas/vendor";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import {
  createCurrencyColumn,
  createPlainDateColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";

const EMBEDDED_TABLE_STATE = {
  initialSort: "date",
  urlSync: false,
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
  const columns = useMemo(
    () => [
      createPlainDateColumn(helper, "date", { header: "Date" }),
      helper.display({
        id: "purchase",
        header: "Purchase",
        meta: { className: "w-56" },
        cell: (info) => (
          <EntityInlineLink entity="purchase" data={info.row.original} />
        ),
      }),
      helper.accessor("expenseCount", {
        header: "Expense count",
        meta: { numeric: true, className: "w-24" },
      }),
      createCurrencyColumn(helper, "statedTotal", {
        header: "Stated",
        className: "w-24",
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
    extraFilters: scope,
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

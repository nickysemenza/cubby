import type { VendorFilters, VendorOut } from "@cubby/schemas/vendor";
import { createColumnHelper } from "@tanstack/react-table";
import { type ReactNode, useMemo } from "react";
import {
  createCurrencyColumn,
  createPlainDateColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { ExternalLinkText } from "~/app/_components/ExternalLink";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { VendorMark } from "~/components/entity/vendor-cell";
import { usePageCount } from "~/components/page/Page";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { vendorMutationInvalidateKeys } from "~/lib/query-keys";

/**
 * Open on biggest spenders first, overriding `entities.vendor.list.defaultSort`
 * ("name"). `useTableState`'s initial state is always DESCENDING, so defaulting
 * to name would land the roster on Z→A — and "where did the money go" is the
 * question this table exists to answer anyway. Module-level: it feeds
 * `useEntityList`'s tableState memo.
 */
const VENDOR_TABLE_STATE = { initialSort: "spend" } as const;

/**
 * The brand mark leading each vendor's name. Module-level for the same reason as
 * tasklist's `subtaskCountSuffix`: `namePrefix` sits in useStandardColumns'
 * columns-`useMemo` dependency array, so an inline arrow would churn the memo
 * every render.
 */
const VENDOR_NAME_PREFIX = (row: VendorOut): ReactNode => (
  <VendorMark vendor={row.name} vendorId={row.id} />
);

export function VendorList() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<VendorOut>(), []);
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("vendor");

  const updateVendorMutation = useUpdateMutation({
    mutationFn: api.vendor.update.mutationOptions,
    entity: "vendor",
    invalidateKeys: vendorMutationInvalidateKeys,
  });

  const nameEditable = useNameEditable<VendorOut>(
    updateVendorMutation.mutateAsync,
  );

  // `deleteVendors` refuses while live purchases still point at the vendor
  // (VENDOR_HAS_PURCHASES) — the server message surfaces in the delete dialog's
  // error toast, which is the intended UX: re-point the purchases first.
  const deletableConfig = useDeletableConfig({
    mutationFn: api.vendor.delete.mutationOptions,
    entityLabel: "Vendor",
    invalidateKeys: vendorMutationInvalidateKeys,
    entity: "vendor",
  });

  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => row.website, {
        id: "website",
        header: "Website",
        enableSorting: false,
        meta: {
          className: "w-40",
          mobile: { slot: "meta", priority: 30, interactive: true },
        },
        cell: (info) => {
          const website = info.getValue();
          if (!website) return <NoneValue />;
          return <ExternalLinkText href={website} truncate />;
        },
      }),
      columnHelper.accessor((row) => row.purchaseCount, {
        id: "purchaseCount",
        header: "Purchases",
        meta: {
          numeric: true,
          className: "w-24",
          mobile: { slot: "meta", priority: 20 },
        },
        cell: (info) => (
          <span className="font-mono tabular-nums">{info.getValue()}</span>
        ),
      }),
      // `zeroAsEmpty: false` — a vendor on the roster with no spend yet is a real
      // $0, not an unset price, and the dash would read as "unknown".
      // `signedTone` because vendor spend genuinely goes negative (a refund-only
      // vendor, or the family wedding contributions), and a credit must not read
      // as spend. The footer is exact: `vendorList` returns a `sums.spend` over
      // the whole filtered set, and `createCurrencyColumn` prefers that server
      // aggregate over reducing the loaded rows (keyed on the column id, so no
      // wiring here beyond naming the column `spend`).
      createCurrencyColumn(columnHelper, "spend", {
        header: "Spend",
        className: "w-28",
        decimals: 0,
        zeroAsEmpty: false,
        signedTone: true,
        mobile: { slot: "trailing", priority: 5 },
      }),
      createPlainDateColumn(columnHelper, "latestPurchaseDate", {
        header: "Latest purchase",
        className: "w-32",
        mobile: { slot: "meta", priority: 35 },
      }),
    ],
    [columnHelper],
  );

  // Neither `buildFilters` nor `filters` is passed: the `vendor` entry in
  // `entities/filter-manifest.tsx` drives all three surfaces at once — the Name
  // search box, the server `VendorFilters` object, and the `?q=` URL round-trip
  // that makes a filtered roster shareable.
  const {
    table,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
    totalCount,
  } = useEntityList<VendorOut, VendorFilters>({
    entity: "vendor",
    queryOptions: api.vendor.list.queryOptions,
    columns,
    deletable: deletableConfig,
    nameEditable,
    tableStateOptions: VENDOR_TABLE_STATE,
    // Sparse table (four columns), so the name gets a fixed width instead of
    // ballooning to absorb the leftover space under the fixed layout.
    nameClassName: "w-64",
    // The roster reads by brand: the same mark the ledger's vendor cell leads
    // with, so a vendor looks identical wherever it appears. `VendorMark` falls
    // back to a monogram tile, so every row carries something (roughly half the
    // roster is one-off local trades with no logo). It's a fixed-width
    // `shrink-0` glyph, so the name keeps truncating at `w-64`.
    namePrefix: VENDOR_NAME_PREFIX,
  });
  usePageCount(totalCount);

  return (
    <div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Vendors Table"
        timing={timing}
        entity="vendor"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
      />
      <PreviewSheet />
      {deleteDialog}
    </div>
  );
}

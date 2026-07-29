import type { VendorFilters, VendorOut } from "@cubby/schemas/vendor";
import { VENDOR_KIND_LABELS } from "@cubby/schemas/vendor";
import { createColumnHelper } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import { useMemo } from "react";
import {
  createCurrencyColumn,
  createFilterableSelectColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { usePageCount } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { vendorMutationInvalidateKeys } from "~/lib/query-keys";
import { VENDOR_KIND_BADGE_VARIANT, vendorKindOptions } from "./vendor-options";

/**
 * Open on biggest spenders first, overriding `entities.vendor.list.defaultSort`
 * ("name"). `useTableState`'s initial state is always DESCENDING, so defaulting
 * to name would land the roster on Z→A — and "where did the money go" is the
 * question this table exists to answer anyway. Module-level: it feeds
 * `useEntityList`'s tableState memo.
 */
const VENDOR_TABLE_STATE = { initialSort: "spend" } as const;

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

  // `deleteVendors` refuses while live charges still point at the vendor
  // (VENDOR_HAS_PURCHASES) — the server message surfaces in the delete dialog's
  // error toast, which is the intended UX: re-point the charges first.
  const deletableConfig = useDeletableConfig({
    mutationFn: api.vendor.delete.mutationOptions,
    entityLabel: "Vendor",
    invalidateKeys: vendorMutationInvalidateKeys,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateVendorMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      createFilterableSelectColumn(columnHelper, "kind", {
        header: "Kind",
        placeholder: "Filter by kind...",
        selectOptions: vendorKindOptions,
        className: "w-32",
        mobile: { slot: "meta", priority: 10 },
        editable: {
          onSave: async (kind, vendor) => {
            await updateVendorMutation.mutateAsync({
              id: vendor.id,
              data: { kind },
            });
          },
        },
        renderCell: (kind) =>
          kind ? (
            <Badge variant={VENDOR_KIND_BADGE_VARIANT[kind]}>
              {VENDOR_KIND_LABELS[kind]}
            </Badge>
          ) : (
            <NoneValue />
          ),
      }),
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
          return (
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 truncate text-muted-foreground transition-colors hover:text-primary"
            >
              <span className="truncate">{website}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          );
        },
      }),
      columnHelper.accessor((row) => row.purchaseCount, {
        id: "purchaseCount",
        header: "Charges",
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
    ],
    [columnHelper],
  );

  // Neither `buildFilters` nor `filters` is passed: the `vendor` entry in
  // `entities/filter-manifest.tsx` drives all three surfaces at once — the Name
  // search box and the Kind multiselect (`manifestFilterConfig` overlays the
  // control onto the column above), the server `VendorFilters` object, and the
  // `?q=`/`?kind=` URL round-trip that makes a filtered roster shareable.
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
    // Sparse table (five columns), so the name gets a fixed width instead of
    // ballooning to absorb the leftover space under the fixed layout.
    nameClassName: "w-64",
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

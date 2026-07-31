import type { PurchaseFilters, PurchaseOut } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { FileText } from "lucide-react";
import { useMemo } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { VendorMark } from "~/components/entity/vendor-cell";
import { Grid, Row } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { NoneValue } from "~/components/ui/none-value";
import { StatTile } from "~/components/ui/stat-tile";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseLabel } from "~/lib/purchase-label";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import {
  createCurrencyColumn,
  createPlainDateColumn,
  createTextColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { TableLink } from "../_components/table/TableLink";
import { ReconciliationBadge } from "./purchase-reconciliation";

// Stable empty default — an inline `?? []` would allocate a fresh array every
// render while the options query is loading, destabilizing the memo chain below
// (see apps/web/CLAUDE.md's `unstable-hook-default` rule).
const NO_VENDOR_OPTIONS: FilterableComboboxItem[] = [];

/**
 * The charges table — one row per vendor transaction.
 *
 * Columns split the two totals on purpose: `statedTotal` is what the paperwork
 * claimed and is NEVER summed (no footer total on that column — a column sum of
 * stated totals would read as spend, which it explicitly isn't), while
 * `expenseTotal` is `SUM(expense.cost)` and IS the charge's spend.
 */
export function PurchaseList() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<PurchaseOut>(), []);

  // Runtime roster for the manifest's `vendor` spec (`optionsKey: "vendor"`).
  // The option's VALUE is the vendor id — the spec is `idMulti` on `vendorId`,
  // so a name here would be branded into a lie and match nothing. The charge
  // count rides in `hint`, never the label (the label is what filter chips and
  // the collapsed multi-select summary interpolate, and what the type-ahead
  // matches on), and each option keeps the vendor's brand mark.
  const vendorOptionsQuery = useQuery(api.vendor.options.queryOptions());
  const vendorOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      vendorOptionsQuery.data?.map(({ id, name, count }) => ({
        value: id,
        label: name,
        hint: String(count),
        icon: <VendorMark vendor={name} vendorId={id} />,
      })) ?? NO_VENDOR_OPTIONS,
    [vendorOptionsQuery.data],
  );

  const filterOptions = useFilterOptions({ vendor: vendorOptions });

  const deletableConfig = useDeletableConfig({
    mutationFn: api.purchase.delete.mutationOptions,
    entityLabel: "Purchase",
    invalidateKeys: purchaseMutationInvalidateKeys,
    entity: "purchase",
  });

  const columns = useMemo(
    () => [
      // A purchase has no `name`, so this is its name column: the identity
      // ladder from `purchaseLabel` (order id, else vendor · date), linked to
      // the charge itself and carrying the order-id substring search.
      columnHelper.accessor((row) => purchaseLabel(row), {
        id: "charge",
        header: "Charge",
        enableSorting: false,
        meta: { className: "w-56", mobile: { slot: "title", priority: 0 } },
        cell: (info) => (
          <TableLink
            to={entities.purchase.routes.detail}
            params={entityDetailParams(info.row.original.id)}
            className="block truncate"
          >
            {info.getValue()}
          </TableLink>
        ),
      }),
      columnHelper.accessor((row) => row.vendorName, {
        id: "vendor",
        header: "Vendor",
        meta: { className: "w-48", mobile: { slot: "subtitle", priority: 10 } },
        cell: (info) => {
          const row = info.row.original;
          return row.vendorName && row.vendorId ? (
            <EntityInlineLink
              entity="vendor"
              data={{
                id: row.vendorId,
                name: row.vendorName,
                shortcode: row.vendorId,
              }}
              truncate
            />
          ) : (
            <NoneValue />
          );
        },
      }),
      // Raw vendor id, mono — the value a receipt prints. Its header control is
      // the presence worklist: the ~40% of charges with no order id at all.
      createTextColumn(columnHelper, "orderId", {
        header: "Order #",
        className: "w-40 font-mono",
        mobile: { slot: "meta", priority: 20 },
      }),
      createPlainDateColumn(columnHelper, "date", {
        header: "Date",
        mobile: { slot: "meta", priority: 30 },
      }),
      // Hand-rolled rather than `createCurrencyColumn`: that factory footers a
      // column total, and a summed `statedTotal` column would read as spend.
      // Stated totals are a per-charge reconciliation cue only.
      columnHelper.accessor((row) => row.statedTotal, {
        id: "statedTotal",
        header: "Stated",
        meta: {
          numeric: true,
          className: "w-24",
          mobile: { slot: "meta", priority: 40 },
        },
        cell: (info) => {
          const value = info.getValue();
          return value == null ? <NoneValue /> : formatCurrency(value);
        },
      }),
      columnHelper.accessor((row) => row.expenseCount, {
        id: "expenseCount",
        header: "Lines",
        meta: {
          numeric: true,
          className: "w-32",
          mobile: { slot: "meta", priority: 50 },
        },
        cell: (info) => {
          const row = info.row.original;
          return (
            <Row align="center" justify="end" gap="xs">
              <span className="font-mono tabular-nums">{info.getValue()}</span>
              {row.unpricedExpenseCount > 0 && (
                <Badge variant="warning">
                  {row.unpricedExpenseCount} unpriced
                </Badge>
              )}
            </Row>
          );
        },
      }),
      // THIS is the charge's spend, so it does carry a footer total.
      createCurrencyColumn(columnHelper, "expenseTotal", {
        header: "Line total",
        className: "w-28",
        zeroAsEmpty: false,
        signedTone: true,
        mobile: { slot: "trailing", priority: 5 },
      }),
      columnHelper.display({
        id: "reconciliation",
        header: "Reconciles",
        meta: { className: "w-32", mobile: { slot: "meta", priority: 60 } },
        cell: (info) => <ReconciliationBadge purchase={info.row.original} />,
      }),
      columnHelper.accessor((row) => row.documentCount, {
        id: "documentCount",
        header: "Documents",
        meta: {
          numeric: true,
          className: "w-20",
          mobile: { slot: "meta", priority: 70 },
        },
        cell: (info) =>
          info.getValue() > 0 ? (
            <Row align="center" justify="end" gap="xs">
              <FileText className="size-3.5 text-muted-foreground" />
              <span className="font-mono tabular-nums">{info.getValue()}</span>
            </Row>
          ) : (
            <NoneValue />
          ),
      }),
    ],
    [columnHelper],
  );

  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("purchase");

  const {
    table,
    data,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
    totalCount,
  } = useEntityList<PurchaseOut, PurchaseFilters>({
    entity: "purchase",
    queryOptions: api.purchase.list.queryOptions,
    filterOptions,
    columns,
    deletable: deletableConfig,
  });
  usePageCount(totalCount);

  // Loaded-pages figures, and labelled as such: there's no purchase-side
  // analytics procedure to ask for the full filtered set (the ledger's totals
  // live on `expense.analytics`), so these summarize what's on screen rather
  // than claiming to be the whole result.
  const loadedTotal = useMemo(
    () => data.reduce((sum, row) => sum + row.expenseTotal, 0),
    [data],
  );
  const loadedLines = useMemo(
    () => data.reduce((sum, row) => sum + row.expenseCount, 0),
    [data],
  );

  return (
    <div>
      <Grid cols="summary" className="mb-4">
        <StatTile label="Charges">{totalCount ?? 0}</StatTile>
        <StatTile label="Shown">{data.length}</StatTile>
        <StatTile label="Lines (shown)">{loadedLines}</StatTile>
        <StatTile label="Spend (shown)">
          {formatCurrency(loadedTotal, 0)}
        </StatTile>
      </Grid>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Purchases Table"
        timing={timing}
        entity="purchase"
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

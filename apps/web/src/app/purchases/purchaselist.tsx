import type { PurchaseFilters, PurchaseOut } from "@cubby/schemas/purchase";
import { sumBy } from "es-toolkit";
import { FileText } from "lucide-react";
import { useCallback, useMemo } from "react";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { VendorCell } from "~/components/entity/vendor-cell";
import { Grid, Row } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import { StatTile } from "~/components/ui/stat-tile";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { createEntityDisplayColumns } from "~/entities/entity-display";
import { entityListFor } from "~/entities/entity-list.functions";
import { dataQualityOptions } from "~/lib/data-quality-options";
import { purchaseIdentityLabel } from "~/lib/purchase-label";
import { formatCurrency } from "~/lib/utils";

import {
  createCurrencyColumn,
  createPlainDateColumn,
  createTextColumn,
  renderOptionCell,
} from "../_components/data-table/columnHelpers";
import { ListWorkbench } from "../_components/data-table/ListWorkbench";
import { useDeferredFilterOptions } from "../_components/hooks/useDeferredFilterOptions";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import type { ListQueryOptionsFn } from "../_components/hooks/usePaginatedTableCore";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { TableLink } from "../_components/table/TableLink";
import { FinancialSettlementBadge } from "./financial-settlement";
import { ReconciliationBadge } from "./purchase-reconciliation";

// Stable empty default — an inline `?? []` would allocate a fresh array every
// render while the options query is loading, destabilizing the memo chain below
// (see apps/web/CLAUDE.md's `unstable-hook-default` rule).
/**
 * The purchases table — one row per vendor transaction.
 *
 * Columns split the two totals on purpose: `statedTotal` is what the paperwork
 * claimed and is NEVER summed (no footer total on that column — a column sum of
 * stated totals would read as spend, which it explicitly isn't), while
 * `expenseTotal` is `SUM(expense.cost)` and IS the purchase's spend.
 */
export function PurchaseList() {
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<PurchaseOut>(),
    [],
  );
  const listQueryOptions = useCallback<
    ListQueryOptionsFn<PurchaseFilters, PurchaseOut>
  >((params) => entityListFor("purchase").listQueryPlan(params), []);

  // Runtime roster for the manifest's `vendor` spec (`optionsKey: "vendor"`).
  // The option's VALUE is the vendor id — the spec is `idMulti` on `vendorId`,
  // so a name here would be branded into a lie and match nothing. The purchase
  // count rides in `hint`, never the label (the label is what filter chips and
  // the collapsed multi-select summary interpolate, and what the type-ahead
  // matches on), and each option keeps the vendor's brand mark.
  const vendorOptions = useDeferredFilterOptions("vendor");
  const projectOptions = useDeferredFilterOptions("project");

  const filterOptions = useFilterOptions({
    vendor: vendorOptions,
    project: projectOptions,
  });

  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("purchase", "update"),
    entity: "purchase",
  });

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<PurchaseOut>((add) => {
        // Computed purchase identity and ledger summaries retain their domain renderers.

        // A purchase has no `name`, so this is its name column: the identity
        // ladder from `purchaseIdentityLabel` (order id, else vendor · date),
        // linked to the purchase itself and carrying the broad identity search.
        // Human context has its own column below, so it is not duplicated here.
        add(
          columnHelper.accessor((row) => purchaseIdentityLabel(row), {
            id: "purchase",
            header: "Purchase",
            enableSorting: false,
            meta: {
              className: "w-56",
              mobile: { slot: "title", priority: 0 },
            },
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
        );

        add(
          columnHelper.display({
            id: "financialSettlement",
            header: "Settlement",
            meta: {
              className: "w-28",
              mobile: { slot: "meta", priority: 65 },
            },
            cell: (info) => (
              <FinancialSettlementBadge purchase={info.row.original} />
            ),
          }),
        );

        // Hidden by default. These three exist so the transaction-presence and
        // data-quality specs are column-backed: a urlOnly spec can never
        // round-trip through a header control, and a non-urlOnly spec with no
        // column makes TanStack error on every render.
        add(
          columnHelper.accessor(
            (row) => row.financialReconciliation.transactionCount,
            {
              id: "transactionCount",
              header: "Transactions",
              enableSorting: false,
              meta: { numeric: true, className: "w-24" },
              cell: (info) =>
                info.getValue() > 0 ? (
                  <span className="font-mono tabular-nums">
                    {info.getValue()}
                  </span>
                ) : (
                  <NoneValue />
                ),
            },
          ),
        );

        add(
          columnHelper.accessor(
            (row) => row.dataQuality.gaps.map((gap) => gap.check).join(", "),
            {
              id: "dataGaps",
              header: "Data gaps",
              enableSorting: false,
              meta: { className: "w-48" },
              cell: (info) => info.getValue() || <NoneValue />,
            },
          ),
        );
        createEntityDisplayColumns(
          "purchase",
          columnHelper,
          createCubbyColumnCollection<PurchaseOut>((add) => {
            add(
              columnHelper.accessor((row) => row.vendorName, {
                id: "vendor",
                header: "Vendor",
                meta: {
                  className: "w-48",
                  mobile: { slot: "subtitle", priority: 10 },
                },
                cell: (info) => {
                  const row = info.row.original;
                  return row.vendorName && row.vendorId ? (
                    <VendorCell
                      vendor={row.vendorName}
                      vendorId={row.vendorId}
                      logo={row.vendorLogo}
                      compactOnMobile
                    />
                  ) : (
                    <NoneValue />
                  );
                },
              }),
            );

            // Raw vendor id, mono — the value a receipt prints. Its header control is
            // the presence worklist: the ~40% of purchases with no order id at all.
            add(
              createTextColumn(columnHelper, "orderId", {
                header: "Order #",
                className: "w-40 font-mono",
                mobile: { slot: "meta", priority: 20 },
                renderValue: (v, purchase) =>
                  v ? (
                    <Row align="center" gap="xs">
                      <span className="min-w-0 truncate">{v}</span>
                      <OrderIdLink
                        orderUrl={purchase.orderUrl}
                        orderId={v}
                        vendorName={purchase.vendorName}
                      />
                    </Row>
                  ) : (
                    <NoneValue />
                  ),
              }),
            );

            add(
              createTextColumn(columnHelper, "displayLabel", {
                header: "Display label",
                placeholder: "e.g. pocket hole jig + bits",
                className: "w-56",
                mobile: {
                  slot: "subtitle",
                  priority: 5,
                  interactive: true,
                },
                editable: {
                  onSave: async (displayLabel, purchase) => {
                    await update.mutateAsync({
                      id: purchase.id,
                      data: { displayLabel },
                    });
                  },
                },
              }),
            );

            add(
              createPlainDateColumn(columnHelper, "date", {
                header: "Date",
                mobile: { slot: "meta", priority: 30 },
              }),
            );

            // Hand-rolled rather than `createCurrencyColumn`: that factory footers a
            // column total, and a summed `statedTotal` column would read as spend.
            // Stated totals are a per-purchase reconciliation cue only.
            add(
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
            );

            add(
              columnHelper.accessor((row) => row.expenseCount, {
                id: "expenseCount",
                header: "Expenses",
                meta: {
                  numeric: true,
                  className: "w-32",
                  mobile: { slot: "meta", priority: 50 },
                },
                cell: (info) => {
                  const row = info.row.original;
                  return (
                    <Row align="center" justify="end" gap="xs">
                      <span className="font-mono tabular-nums">
                        {info.getValue()}
                      </span>
                      {row.unpricedExpenseCount > 0 && (
                        <Badge variant="warning">
                          {row.unpricedExpenseCount} unpriced
                        </Badge>
                      )}
                    </Row>
                  );
                },
              }),
            );

            // THIS is the purchase's spend, so it does carry a footer total.
            add(
              createCurrencyColumn(columnHelper, "expenseTotal", {
                header: "Expense total",
                className: "w-28",
                signedTone: true,
                mobile: { slot: "trailing", priority: 5 },
              }),
            );

            add(
              columnHelper.display({
                id: "reconciliation",
                header: "Reconciles",
                meta: {
                  className: "w-48",
                  mobile: { slot: "meta", priority: 60 },
                },
                cell: (info) => (
                  <ReconciliationBadge purchase={info.row.original} />
                ),
              }),
            );

            add(
              columnHelper.accessor((row) => row.dataQuality.status, {
                id: "dataQuality",
                header: "Data quality",
                enableSorting: false,
                meta: { className: "w-28" },
                cell: (info) =>
                  renderOptionCell(info.getValue(), dataQualityOptions),
              }),
            );

            add(
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
                      <span className="font-mono tabular-nums">
                        {info.getValue()}
                      </span>
                    </Row>
                  ) : (
                    <NoneValue />
                  ),
              }),
            );
          }),
        ).visit(add);
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- mutation wrapper is functionally stable
    [columnHelper],
  );

  const { workbench, data, totalCount, inspection } = useEntityList<
    PurchaseOut,
    PurchaseFilters
  >({
    entity: "purchase",
    preview: { responsiveInspector: true },
    queryOptions: listQueryOptions,
    filterOptions,
    columns,
    deletable: true,
    initialColumnVisibility: {
      transactionCount: false,
      dataQuality: false,
      dataGaps: false,
    },
  });
  const {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    preview,
    dockedInspector,
    inspectorToggle,
  } = inspection;
  usePageCount(totalCount);

  // Loaded-pages figures, and labelled as such: there's no purchase-side
  // analytics procedure to ask for the full filtered set (the ledger's totals
  // live on `expense.analytics`), so these summarize what's on screen rather
  // than claiming to be the whole result.
  const loadedTotal = useMemo(
    () => sumBy(data, (row) => row.expenseTotal),
    [data],
  );
  const loadedExpenses = useMemo(
    () => sumBy(data, (row) => row.expenseCount),
    [data],
  );

  return (
    <div>
      <Grid cols="summary" className="mb-4">
        <StatTile label="Purchases">{totalCount ?? 0}</StatTile>
        <StatTile label="Shown">{data.length}</StatTile>
        <StatTile label="Expenses (shown)">{loadedExpenses}</StatTile>
        <StatTile label="Spend (shown)">
          {formatCurrency(loadedTotal, 0)}
        </StatTile>
      </Grid>
      <ListWorkbench
        model={workbench}
        ariaLabel="Purchases Table"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        onRowHoverEnd={onRowHoverEnd}
        currentRowId={preview?.id}
        desktopInspector={dockedInspector}
        inspectorToggle={inspectorToggle}
      />
      <PreviewSheet />
    </div>
  );
}

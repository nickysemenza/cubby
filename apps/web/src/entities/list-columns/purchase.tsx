import type { PurchaseFilters, PurchaseOut } from "@cubby/schemas/purchase";
import { sumBy } from "es-toolkit";
import { useMemo } from "react";

import {
  createCurrencyColumn,
  createTextColumn,
} from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import { useDeferredFilterOptions } from "~/app/_components/hooks/useDeferredFilterOptions";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { FinancialSettlementCell } from "~/app/purchases/financial-settlement";
import { ReconciliationStatus } from "~/app/purchases/purchase-reconciliation";
import { VendorCell } from "~/components/entity/vendor-cell";
import { Grid, Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import { StatTile } from "~/components/ui/stat-tile";
import { entityListHiddenColumns } from "~/entities/entity-display";
import {
  labeledFieldProvenance,
  relationshipFieldProvenance,
} from "~/entities/field-provenance";
import { formatCurrency } from "~/lib/utils";

import { defineListOverride, interleaveDeclared } from "./types";

const columnHelper = createCubbyColumnHelper<PurchaseOut>();

// `transactionCount`/`dataGaps` are computed columns outside the field model.
const PURCHASE_INITIAL_COLUMN_VISIBILITY = {
  transactionCount: false,
  dataGaps: false,
  ...entityListHiddenColumns("purchase"),
};

/**
 * Loaded-pages figures, labelled as such: there is no purchase-side analytics
 * procedure for the full filtered set (the ledger's totals live on
 * `expense.analytics`), so these summarize what is on screen.
 */
function PurchaseStats({
  data,
  totalCount,
}: {
  data: PurchaseOut[];
  totalCount: number | undefined;
}) {
  const loadedTotal = useMemo(
    () => sumBy(data, (row) => row.expenseTotal),
    [data],
  );
  const loadedExpenses = useMemo(
    () => sumBy(data, (row) => row.expenseCount),
    [data],
  );
  return (
    <Grid cols="summary" className="mb-4">
      <StatTile label="Purchases">{totalCount ?? 0}</StatTile>
      <StatTile label="Shown">{data.length}</StatTile>
      <StatTile label="Expenses (shown)">{loadedExpenses}</StatTile>
      <StatTile label="Spend (shown)">
        {formatCurrency(loadedTotal, 0)}
      </StatTile>
    </Grid>
  );
}

/**
 * The two totals split on purpose: `statedTotal` is what the paperwork
 * claimed and is NEVER summed (a column sum of stated totals would read as
 * spend, which it isn't), while `expenseTotal` is `SUM(expense.cost)`.
 */
export const purchaseListOverride = defineListOverride<
  PurchaseOut,
  PurchaseFilters
>({
  use() {
    // The option's VALUE is the vendor id (the spec is `idMulti` on
    // `vendorId`); the purchase count rides in `hint`, never the label.
    const vendorOptions = useDeferredFilterOptions("vendor");
    const projectOptions = useDeferredFilterOptions("project");
    const filterOptions = useFilterOptions({
      vendor: vendorOptions,
      project: projectOptions,
    });

    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<PurchaseOut>((add) => {
          add(
            columnHelper.accessor((row) => row.vendorName, {
              id: "vendorId",
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
          // Raw vendor id, mono — the value a receipt prints. Its header
          // control is the presence worklist.
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
                    <span className="tabular-nums">{info.getValue()}</span>
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
              id: "financialReconciliation",
              header: "Settlement",
              meta: {
                provenanceWorkbenchHandled: true,
                className: "w-32",
                mobile: {
                  slot: "meta",
                  priority: 65,
                  interactive: true,
                },
              },
              cell: (info) => (
                <FinancialSettlementCell purchase={info.row.original} />
              ),
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
                <ReconciliationStatus purchase={info.row.original} />
              ),
            }),
          );
        }),
      [],
    );

    const compose = useMemo(
      () => (declared: CubbyColumnCollection<PurchaseOut>) =>
        createCubbyColumnCollection<PurchaseOut>((add) => {
          const { rest } = interleaveDeclared(declared, add);
          // Hidden by default; these exist so the transaction-presence and
          // data-quality specs are column-backed (a spec with no column makes
          // TanStack error on every render).
          add(
            columnHelper.accessor(
              (row) => row.financialReconciliation.transactionCount,
              {
                id: "transactionCount",
                header: "Transactions",
                enableSorting: false,
                meta: {
                  provenance: relationshipFieldProvenance(
                    "purchase",
                    "financial-transactions",
                  ),
                  numeric: true,
                  className: "w-24",
                  explanation: {
                    entity: "purchase",
                    field: "transactionCount",
                    label: "Transactions",
                  },
                },
                cell: (info) =>
                  info.getValue() > 0 ? (
                    <span className="tabular-nums">{info.getValue()}</span>
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
                meta: {
                  provenance: labeledFieldProvenance("Purchase data quality"),
                  className: "w-48",
                  explanation: {
                    entity: "purchase",
                    field: "dataGaps",
                    label: "Data gaps",
                  },
                },
                cell: (info) => info.getValue() || <NoneValue />,
              },
            ),
          );
          rest();
        }),
      [],
    );

    const list = useMemo(
      () => ({
        deletable: true as const,
        filterOptions,
        initialColumnVisibility: PURCHASE_INITIAL_COLUMN_VISIBILITY,
      }),
      [filterOptions],
    );

    return {
      overrides,
      compose,
      list,
      above: ({ data, totalCount }) => (
        <PurchaseStats data={data} totalCount={totalCount} />
      ),
    };
  },
});

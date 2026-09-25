import type {
  ExpenseOut,
  ProjectStatus,
  TaskStatus,
} from "@cubby/schemas/project";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import { Link } from "@tanstack/react-router";
import { z } from "zod";

import {
  type VendorName,
  WithVendorSearch,
} from "~/app/_components/combobox/with-vendor-search";
import {
  entityCellData,
  specFromCellData,
} from "~/app/_components/data-table/cell-data";
import {
  createTextColumn,
  type MobileColumnMeta,
} from "~/app/_components/data-table/columnHelpers";
import { EditableEntityCell } from "~/app/_components/data-table/editable-entity-cell";
import {
  type CubbyColumnHelper as ColumnHelper,
  type CubbyFilterFn as FilterFn,
} from "~/app/_components/data-table/table-features";
import { attachCubbyColumnMeta } from "~/app/_components/data-table/table-meta";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { TableLink } from "~/app/_components/table/TableLink";
import { VendorCell } from "~/components/entity/vendor-cell";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { multiSelectFilterFnBy, type FilterValue } from "~/entities/filters";
import { purchaseLabel } from "~/lib/purchase-label";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { cn } from "~/lib/utils";
import { persistedVendorId } from "~/lib/vendor-logo";

export { TASK_STATUS_LABELS } from "~/app/tasks/task-options";
export {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "~/lib/nivo-theme";
export { getCostTypeColor } from "~/lib/status-colors";
export {
  capitalize,
  formatDate,
  formatDateRange,
  monthKey,
  monthLabel,
  normalizeCostTypeKey,
  PROJECT_STATUS_LABELS,
  TRADE_LABELS,
} from "./project-formatting";
export { TradeBadge, TradeIcon } from "./trade-options";

export function StatusIcon({ status }: { status: ProjectStatus | TaskStatus }) {
  const { icon: Icon, className } = getStatusBadgeProps("project", status);
  // Extract just the text color from the bg+text className tuple.
  const textClass =
    className.split(" ").find((c) => c.startsWith("text-")) ??
    "text-muted-foreground";
  return Icon ? <Icon className={cn("size-4 shrink-0", textClass)} /> : null;
}

/** Match id-valued Vendor options against `row.vendorId`, not the displayed name. */
const matchesVendorId = multiSelectFilterFnBy<string | null, FilterValue>(
  (v) => v,
);
const vendorIdFilterFn: FilterFn<ExpenseOut> = (row, columnId, filterValue) =>
  matchesVendorId(
    { getValue: () => row.original.vendorId },
    columnId,
    filterValue,
  );

/**
 * Vendor edits use the full roster to avoid case-variant duplicates; filtering
 * uses id-valued options supplied by each list surface.
 */
export function expenseVendorColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (vendor: string | null, expense: ExpenseOut) => Promise<void>,
  opts?: {
    id?: string;
    mobile?: MobileColumnMeta;
    vendorOptions?: FilterableComboboxItem[];
    /** Render the charge identity/link while retaining vendor editing/filtering. */
    asPurchase?: boolean;
  },
) {
  const cellData = entityCellData<ExpenseOut, VendorName>(
    "vendor",
    (value) => z.string().min(1).parse(value),
    (row) => (row.vendor ? { id: row.vendor, name: row.vendor } : null),
    (row, value) => save(value, row),
    (row) => save(null, row),
  );

  return helper.accessor((row) => row.vendor, {
    id: opts?.id ?? "vendor",
    header: opts?.asPurchase ? "Purchase" : "Vendor",
    filterFn: vendorIdFilterFn,
    meta: attachCubbyColumnMeta({
      className: opts?.asPurchase ? "w-56" : "w-40",
      mobile: opts?.mobile,
      filterConfig: manifestFilterConfig(
        "expense",
        opts?.id ?? "vendor",
        opts?.vendorOptions ? { vendor: opts.vendorOptions } : undefined,
      ),
      cellData,
    }),
    cell: (info) => {
      const expense = info.row.original;
      const vendor = info.getValue();
      return (
        <EditableEntityCell<VendorName>
          value={vendor ? { id: vendor, name: vendor } : null}
          label="vendor"
          clearable
          // Keep editing outside the link trigger.
          trigger="pencil"
          onSave={(newVendor) => save(newVendor, expense)}
          clipboard={specFromCellData(cellData, expense)}
          SearchProvider={WithVendorSearch}
          renderValue={(v) => {
            if (opts?.asPurchase) {
              if (expense.purchaseId) {
                const label = purchaseLabel({
                  orderId: expense.orderId,
                  displayLabel: expense.purchaseDisplayLabel,
                  vendorName: v?.name ?? expense.vendor,
                  date: expense.purchaseDate,
                });
                return (
                  <TableLink
                    to={entities.purchase.routes.detail}
                    params={entityDetailParams(expense.purchaseId)}
                    className="block truncate"
                  >
                    <span title={label}>{label}</span>
                  </TableLink>
                );
              }
              return v ? (
                <span className="truncate">{v.name}</span>
              ) : (
                <span className="text-muted-foreground">(none)</span>
              );
            }
            return v ? (
              <VendorCell
                vendor={v.name}
                vendorId={persistedVendorId(v.name, expense)}
                logo={expense.vendorLogo}
                compactOnMobile
              />
            ) : (
              <NoneValue />
            );
          }}
        />
      );
    },
  });
}

/** Presence-filtered order id; its link scopes through the unique Purchase id. */
export function expenseOrderIdColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (orderId: string | null, expense: ExpenseOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta },
) {
  return createTextColumn(helper, "orderId", {
    header: "Order #",
    placeholder: "Vendor order #",
    className: "w-32",
    mobile: opts?.mobile,
    filterConfig: manifestFilterConfig("expense", "orderId"),
    trigger: "pencil",
    renderValue: (v, expense) =>
      v ? (
        <>
          <span className="font-mono">{v}</span>
          <Link
            to="/expenses"
            search={{ order: v }}
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Show the rest of order ${v}`}
          >
            <FunnelIcon className="size-3.5" />
          </Link>
          <OrderIdLink
            orderUrl={expense.orderUrl}
            orderId={v}
            vendorName={expense.vendor}
          />
        </>
      ) : (
        <NoneValue />
      ),
    editable: {
      onSave: async (newOrderId, expense) => {
        await save(newOrderId, expense);
      },
    },
  });
}

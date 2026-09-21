import {
  canClearExpenseDate,
  EXPENSE_DATE_REQUIRED_MESSAGE,
} from "@cubby/schemas/expense-fields";
import {
  expenseLineBasisSchema,
  expenseLineKindSchema,
  type ExpenseLineBasis,
  type ExpenseLineKind,
} from "@cubby/schemas/expense-line-kind";
import {
  costTypeSchema,
  type CostType,
  type ExpenseOut,
  type ProjectStatus,
  type TaskOut,
  type TaskStatus,
  taskStatusSchema,
  type Trade,
  tradeSchema,
} from "@cubby/schemas/project";
import { Link } from "@tanstack/react-router";
import { ListFilter } from "lucide-react";
import { z } from "zod";

import {
  type VendorName,
  WithVendorSearch,
} from "~/app/_components/combobox/with-vendor-search";
import {
  entityCellData,
  numberCellData,
  specFromCellData,
} from "~/app/_components/data-table/cell-data";
import {
  createBooleanColumn,
  createCurrencyColumn,
  createFilterableSelectColumn,
  createPlainDateColumn,
  createTextColumn,
  type FilterConfig,
  type MobileColumnMeta,
  renderOptionCell,
} from "~/app/_components/data-table/columnHelpers";
import { EditableCell } from "~/app/_components/data-table/editable-cell";
import { EditableEntityCell } from "~/app/_components/data-table/editable-entity-cell";
import {
  type CubbyColumnHelper as ColumnHelper,
  type CubbyFilterFn as FilterFn,
} from "~/app/_components/data-table/table-features";
import { attachCubbyColumnMeta } from "~/app/_components/data-table/table-meta";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { TableLink } from "~/app/_components/table/TableLink";
import {
  costTypeOptions,
  expenseFutureOptions,
  expenseLineBasisOptions,
  expenseLineKindOptions,
} from "~/app/expenses/expense-options";
import { taskStatusOptions } from "~/app/tasks/task-options";
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

import { tradeOptions } from "./trade-options";

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
export { TradeBadge, TradeIcon, tradeOptions } from "./trade-options";

export function StatusIcon({ status }: { status: ProjectStatus | TaskStatus }) {
  const { icon: Icon, className } = getStatusBadgeProps("project", status);
  // Extract just the text color from the bg+text className tuple.
  const textClass =
    className.split(" ").find((c) => c.startsWith("text-")) ??
    "text-muted-foreground";
  return Icon ? <Icon className={cn("size-4 shrink-0", textClass)} /> : null;
}

export function taskStatusColumn(
  helper: ColumnHelper<TaskOut>,
  save: (status: TaskStatus, task: TaskOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta },
) {
  return createFilterableSelectColumn(helper, "status", {
    header: "Status",
    className: "w-32",
    placeholder: "Filter by status...",
    selectOptions: taskStatusOptions,
    filterConfig: manifestFilterConfig("task", "status"),
    mobile: opts?.mobile,
    editable: {
      parseValue: (value) => taskStatusSchema.parse(value),
      onSave: async (newStatus, task) => {
        await save(newStatus, task);
      },
    },
  });
}

export function taskTradeColumn(
  helper: ColumnHelper<TaskOut>,
  save: (trade: Trade, task: TaskOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta; emptyAsNull?: boolean },
) {
  return createFilterableSelectColumn(helper, "trade", {
    header: "Trade",
    className: "w-32",
    placeholder: "Filter by trade...",
    selectOptions: tradeOptions,
    filterConfig: manifestFilterConfig("task", "trade"),
    // Only the empty case differs from the shared render: an embedded table
    // suppresses the dash entirely rather than showing "no trade" per row.
    renderCell: (trade: Trade | null) =>
      trade === null && opts?.emptyAsNull
        ? null
        : renderOptionCell(trade, tradeOptions),
    mobile: opts?.mobile,
    editable: {
      parseValue: (value) => tradeSchema.parse(value),
      onSave: async (newTrade, task) => {
        // Required field — a cleared select is a no-op, not a null write.
        if (!newTrade) return;
        await save(newTrade, task);
      },
      suggest: { entity: "task", field: "trade" },
    },
  });
}

export function taskDueColumn(
  helper: ColumnHelper<TaskOut>,
  save: (
    dueDate: string | null,
    task: TaskOut,
    field: "dueDate" | "dueEndDate",
  ) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta; effective?: boolean },
) {
  return createPlainDateColumn(helper, "dueDate", {
    header: "Due",
    className: "w-28",
    mobile: opts?.mobile,
    editValue: opts?.effective
      ? (task) => task.dueEndDate ?? task.dueDate
      : undefined,
    displayValue: opts?.effective
      ? (task) => ({ value: task.dueEndDate ?? task.dueDate })
      : undefined,
    editable: {
      onSave: async (newDueDate, task) => {
        await save(
          newDueDate,
          task,
          opts?.effective && task.dueEndDate !== null
            ? "dueEndDate"
            : "dueDate",
        );
      },
    },
  });
}

export function expenseLineKindColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (lineKind: ExpenseLineKind, expense: ExpenseOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta },
) {
  return createFilterableSelectColumn(helper, "lineKind", {
    header: "Line Kind",
    className: "w-36",
    placeholder: "Filter by line kind...",
    selectOptions: expenseLineKindOptions,
    filterConfig: manifestFilterConfig("expense", "lineKind"),
    mobile: opts?.mobile,
    editable: {
      parseValue: (value) => expenseLineKindSchema.parse(value),
      onSave: async (newLineKind, expense) => {
        if (!newLineKind) return;
        await save(newLineKind, expense);
      },
    },
  });
}

/** Registered even while hidden so its manifest filter has a real column. */
export function expenseLineBasisColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (lineBasis: ExpenseLineBasis, expense: ExpenseOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta },
) {
  return createFilterableSelectColumn(helper, "lineBasis", {
    header: "Itemization",
    className: "w-40",
    placeholder: "Filter by itemization...",
    selectOptions: expenseLineBasisOptions,
    filterConfig: manifestFilterConfig("expense", "lineBasis"),
    mobile: opts?.mobile,
    editable: {
      parseValue: (value) => expenseLineBasisSchema.parse(value),
      onSave: async (newLineBasis, expense) => {
        if (!newLineBasis) return;
        await save(newLineBasis, expense);
      },
    },
  });
}

export function expenseCostTypeColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (costType: CostType, expense: ExpenseOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta },
) {
  return createFilterableSelectColumn(helper, "costType", {
    header: "Cost Type",
    className: "w-28",
    placeholder: "Filter by cost type...",
    selectOptions: costTypeOptions,
    filterConfig: manifestFilterConfig("expense", "costType"),
    mobile: opts?.mobile,
    editable: {
      parseValue: (value) => costTypeSchema.parse(value),
      onSave: async (newCostType, expense) => {
        // Required field — a cleared select is a no-op, not a null write.
        if (!newCostType) return;
        await save(newCostType, expense);
      },
      suggest: { entity: "expense", field: "costType" },
    },
  });
}

export function expenseTradeColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (trade: Trade, expense: ExpenseOut) => Promise<void>,
  opts?: {
    mobile?: MobileColumnMeta;
    emptyAsNull?: boolean;
  },
) {
  return createFilterableSelectColumn(helper, "trade", {
    header: "Trade",
    className: "w-32",
    placeholder: "Filter by trade...",
    selectOptions: tradeOptions,
    filterConfig: manifestFilterConfig("expense", "trade"),
    // Only the empty case differs from the shared render: an embedded table
    // suppresses the dash entirely rather than showing "no trade" per row.
    renderCell: (trade: Trade | null) =>
      trade === null && opts?.emptyAsNull
        ? null
        : renderOptionCell(trade, tradeOptions),
    mobile: opts?.mobile,
    editable: {
      parseValue: (value) => tradeSchema.parse(value),
      onSave: async (newTrade, expense) => {
        // Required field — a cleared select is a no-op, not a null write.
        if (!newTrade) return;
        await save(newTrade, expense);
      },
      suggest: { entity: "expense", field: "trade" },
    },
  });
}

export function expenseCostColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (cost: number | null, expense: ExpenseOut) => Promise<void>,
  opts?: {
    className?: string;
    mobile?: MobileColumnMeta;
    decimals?: number;
    signedTone?: boolean;
  },
) {
  return createCurrencyColumn(helper, "cost", {
    header: "Cost",
    className: opts?.className,
    mobile: opts?.mobile,
    decimals: opts?.decimals,
    signedTone: opts?.signedTone,
    editable: {
      onSave: async (newCost, expense) => {
        await save(newCost, expense);
      },
    },
  });
}

/** Fractional and signed; the cost-aware schema owns sign/zero validation. */
export function expenseProductQuantityColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (quantity: number | null, expense: ExpenseOut) => Promise<void>,
  opts?: {
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    /** Lets a contextual prompt direct focus to one missing quantity. */
    autoOpen?: (expense: ExpenseOut) => boolean;
    /** Stable DOM target for a contextual prompt's scroll-to-editor action. */
    id?: (expense: ExpenseOut) => string;
  },
) {
  const saveValid = async (row: ExpenseOut, quantity: number | null) => {
    if (!row.productId) {
      throw new Error("Link a product before recording its quantity");
    }
    await save(quantity, row);
  };
  const cellData = numberCellData<ExpenseOut>(
    "number",
    (row) => row.productQuantity,
    saveValid,
  );
  return helper.accessor("productQuantity", {
    id: "productQuantity",
    header: "Quantity",
    enableSorting: true,
    meta: attachCubbyColumnMeta({
      numeric: true,
      className: "w-24",
      mobile: opts?.mobile,
      filterConfig: opts?.filterConfig,
      cellData,
    }),
    cell: (info) => {
      const row = info.row.original;
      if (!row.productId) return <NoneValue />;
      return (
        <span id={opts?.id?.(row)}>
          <EditableCell
            value={info.getValue()}
            config={{ type: "number", step: "any", placeholder: "Unknown" }}
            onSave={(quantity) => saveValid(row, quantity)}
            clipboard={specFromCellData(cellData, row)}
            renderValue={(quantity) => quantity ?? <NoneValue />}
            autoOpen={opts?.autoOpen?.(row)}
          />
        </span>
      );
    },
  });
}

export function expenseDateColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (date: string | null, expense: ExpenseOut) => Promise<void>,
  opts?: { mobile?: MobileColumnMeta; filterConfig?: FilterConfig },
) {
  return createPlainDateColumn(helper, "date", {
    header: "Date",
    className: "w-28",
    mobile: opts?.mobile,
    filterConfig: opts?.filterConfig,
    editable: {
      clearable: (row) => canClearExpenseDate(row.cost),
      clearLabel: "Date unknown",
      clearDisabledReason: EXPENSE_DATE_REQUIRED_MESSAGE,
      onSave: async (newDate, expense) => {
        await save(newDate, expense);
      },
    },
  });
}

export function expenseFutureColumn(
  helper: ColumnHelper<ExpenseOut>,
  save: (future: boolean, expense: ExpenseOut) => Promise<void>,
  opts?: {
    className?: string;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
  },
) {
  return createBooleanColumn(helper, "future", {
    header: "Status",
    className: opts?.className ?? "w-24",
    mobile: opts?.mobile,
    filterConfig: opts?.filterConfig ?? null,
    // `future` is non-null, so false is "Actual", never unknown.
    trueFalseOptions: expenseFutureOptions,
    editable: {
      // `next` is only ever a boolean here: the column declares no `undecided`
      // state, so the editor offers no clear affordance.
      onSave: (next, expense) => save(next ?? false, expense),
    },
  });
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
    id: "vendor",
    header: opts?.asPurchase ? "Purchase" : "Vendor",
    filterFn: vendorIdFilterFn,
    meta: attachCubbyColumnMeta({
      className: opts?.asPurchase ? "w-56" : "w-40",
      mobile: opts?.mobile,
      filterConfig: manifestFilterConfig(
        "expense",
        "vendor",
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
            <ListFilter className="size-3.5" />
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

/**
 * Columns off by default on the embedded expense table. Vendor (~30% filled),
 * Order # (~25%) and Product are sparse enough that showing them by default
 * would cost more density than they return on a project page — but the column
 * menu makes them one click away.
 */

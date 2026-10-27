import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { ProjectStatus, TaskStatus } from "@cubby/schemas/project";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import { Link } from "@tanstack/react-router";
import { z } from "zod";

import {
  EntityRefLink,
  VendorOrderLink,
} from "~/entity/components/entity-ref-link";
import { VendorCell } from "~/entity/components/vendor-cell";
import type { ListRowOf } from "~/entity/display/list-renderer-types";
import { manifestFilterConfig } from "~/entity/filter-manifest";
import { multiSelectFilterFnBy, type FilterValue } from "~/entity/filters";
import {
  type VendorName,
  WithVendorSearch,
} from "~/entity/picker/with-vendor-search";
import { createTextColumn } from "~/entity/table/column-helpers";
import { EditableEntityCell } from "~/entity/table/editable-entity-cell";
import { purchaseLabel } from "~/lib/purchase-label";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { persistedVendorId } from "~/lib/vendor-logo";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { entityCellData, specFromCellData } from "~/ui/data-table/cell-data";
import {
  type CubbyColumnHelper as ColumnHelper,
  type CubbyFilterFn as FilterFn,
} from "~/ui/data-table/table-features";
import { type MobileColumnMeta } from "~/ui/data-table/table-meta";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { badgeVariantColor } from "~/ui/primitives/badge";
import { NoneValue } from "~/ui/primitives/none-value";

export { TASK_STATUS_LABELS } from "~/entity/presentation/task-options";

export function StatusIcon({ status }: { status: ProjectStatus | TaskStatus }) {
  const { icon: Icon, variant } = getStatusBadgeProps("project", status);
  return Icon ? (
    <Icon
      className="size-4 shrink-0"
      style={{ color: badgeVariantColor[variant] }}
    />
  ) : null;
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
    vendorOptions?: PickerOption[];
    /** Render the charge identity/link while retaining vendor editing/filtering. */
    asPurchase?: boolean;
  },
) {
  const cellData = entityCellData<ExpenseOut, VendorName>(
    "vendor",
    (value) => z.string().min(1).parse(value),
    (row) => {
      const effectiveRowVendor = fieldValueOf(row.fields.vendor);
      return effectiveRowVendor
        ? { id: effectiveRowVendor, name: effectiveRowVendor }
        : null;
    },
    (row, value) => save(value, row),
    (row) => save(null, row),
  );

  return helper.accessor(
    (row) => {
      const effectiveRowVendor = fieldValueOf(row.fields.vendor);
      return effectiveRowVendor;
    },
    {
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
                const purchaseId = fieldValueOf(expense.fields.purchaseId);
                if (purchaseId) {
                  const label = purchaseLabel({
                    orderId: fieldValueOf(expense.fields.orderId),
                    displayLabel: expense.purchaseDisplayLabel,
                    vendorName: v?.name ?? fieldValueOf(expense.fields.vendor),
                    date: expense.purchaseDate,
                  });
                  return (
                    <EntityRefLink
                      entity="purchase"
                      id={purchaseId}
                      name={label}
                    />
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
                  vendorId={persistedVendorId(v.name, {
                    vendor: fieldValueOf(expense.fields.vendor),
                    vendorId: expense.vendorId,
                  })}
                  logo={expense.vendorLogo}
                />
              ) : (
                <NoneValue />
              );
            }}
          />
        );
      },
    },
  );
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
    renderValue: (v, expense) => {
      const effectiveExpenseOrderUrl = expense.orderUrl;
      const effectiveExpenseVendor = fieldValueOf(expense.fields.vendor);
      return v ? (
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
          <VendorOrderLink
            orderUrl={effectiveExpenseOrderUrl}
            orderId={v}
            vendorName={effectiveExpenseVendor}
          />
        </>
      ) : (
        <NoneValue />
      );
    },
    editable: {
      onSave: async (newOrderId, expense) => {
        await save(newOrderId, expense);
      },
    },
  });
}

type ExpenseOut = ListRowOf<"expense">;

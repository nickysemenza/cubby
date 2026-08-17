import type { ProductWithFoodOut } from "@cubby/schemas/product";
import type { ExpenseOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  type VisibilityState,
} from "@tanstack/react-table";
import { groupBy } from "es-toolkit";
import { type FC, useEffect, useMemo, useState } from "react";
import {
  createProjectLinkColumn,
  createTextColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useClientEntityList } from "~/app/_components/hooks/useClientEntityList";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import {
  ExpenseBulkActionDialogs,
  useExpenseBulkActions,
} from "~/app/_components/tracker/expense-bulk-actions";
import {
  expenseCostColumn,
  expenseCostTypeColumn,
  expenseDateColumn,
  expenseFutureColumn,
  expenseLineKindColumn,
  expenseProductQuantityColumn,
  expenseTradeColumn,
  expenseVendorColumn,
} from "~/app/projects/shared";
import { splitExpenseSpend } from "~/app/projects/spend";
import { VendorMark } from "~/components/entity/vendor-cell";
import { Row, Stack } from "~/components/layout";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { Description } from "~/components/ui/description";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { FILTER_NONE } from "~/entities/filters";
import { useTRPC } from "~/integrations/trpc/react";
import { expenseMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { ShelfEmpty } from "../data-table/shelf";

const EMPTY_EXPENSES: ExpenseOut[] = [];
const QUANTITY_TARGET_PREFIX = "product-expense-quantity-";

/** A section table must not write the product route's URL. */
const EMBEDDED_TABLE_STATE = { urlSync: false, readUrlState: false } as const;

/**
 * Columns off by default. Vendor, Order # and the four classification columns
 * are sparse or repetitive on one product's ledger — they'd cost more density
 * than they return — but the View menu now makes each of them one click away.
 * (Before this table had that menu, any column added here was permanent, which
 * is why it carried only six.)
 */
const INITIAL_COLUMN_VISIBILITY: VisibilityState = {
  project: true,
  vendor: false,
  orderId: false,
  trade: false,
  costType: false,
  lineKind: false,
  future: false,
  createdAt: false,
};

/**
 * Project and Vendor carry ID-valued filter rosters, so their controls must be
 * built by the column factories rather than by `useStandardColumns`' manifest
 * overlay: the overlay forces `multiSelectFilterFn`, which reads the CELL value
 * — an object for Project, the vendor NAME for Vendor — and would compare it
 * against option values that are ids, matching nothing. Listing them here keeps
 * the overlay off so each column's own `projectRefFilterFn` / `vendorIdFilterFn`
 * survives. Server-filtered tables never hit this; this one filters client-side.
 */
const SELF_FILTERED_COLUMNS = ["project", "vendor"];

/** Group key for expenses with no project — a real project id can't collide. */
const UNASSIGNED = "__unassigned__";

interface ProjectRollupEntry {
  /** The project's shortcode, or null for the unassigned bucket. */
  projectId: string | null;
  projectName: string | null;
  /** Actual spend less contributions — the same net the summary line reports. */
  net: number;
}

/**
 * Per-project net spend, using `splitExpenseSpend` so the rollup can't drift
 * from the Net cost line above it (negative expenses are refunds and family
 * contributions — real rows that offset spend, never rows to filter out).
 */
function buildProjectRollup(expenses: ExpenseOut[]): ProjectRollupEntry[] {
  const groups = groupBy(
    expenses,
    (expense) => expense.projectId ?? UNASSIGNED,
  );
  return Object.entries(groups)
    .map(([key, rows]) => {
      const split = splitExpenseSpend(rows);
      return {
        projectId: key === UNASSIGNED ? null : key,
        projectName: rows[0]?.projectName ?? null,
        net: split.actual - split.contributions,
      };
    })
    .sort((left, right) => {
      // Unassigned reads as a remainder, so it belongs after the named projects
      // regardless of size.
      if (left.projectId === null) return 1;
      if (right.projectId === null) return -1;
      return right.net - left.net;
    });
}

/** Expense history for a product, with direct Expense fields editable in place. */
export const ProductExpenseHistory: FC<{ product: ProductWithFoodOut }> = ({
  product,
}) => {
  const api = useTRPC();
  const helper = useMemo(() => createColumnHelper<ExpenseOut>(), []);
  const [quantityEditorExpenseId, setQuantityEditorExpenseId] = useState<
    string | null
  >(null);
  const { data, isPending } = useQuery(
    api.expense.chartData.queryOptions({ productId: product.id }),
  );
  const expenses = data ?? EMPTY_EXPENSES;
  const update = useUpdateMutation({
    mutationFn: api.expense.update.mutationOptions,
    entity: "expense",
    invalidateKeys: expenseMutationInvalidateKeys,
  });
  const nameEditable = useNameEditable<ExpenseOut>(update.mutateAsync);
  const deletable = useDeletableConfig({
    mutationFn: api.expense.delete.mutationOptions,
    entityLabel: "Expense",
    invalidateKeys: expenseMutationInvalidateKeys,
    entity: "expense",
  });
  const bulkActions = useExpenseBulkActions();

  const firstMissingAcquisition = expenses.find(
    (expense) =>
      expense.cost != null &&
      expense.cost > 0 &&
      !expense.future &&
      expense.productQuantity == null,
  );

  useEffect(() => {
    if (!quantityEditorExpenseId) return;
    document
      .getElementById(`${QUANTITY_TARGET_PREFIX}${quantityEditorExpenseId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [quantityEditorExpenseId]);

  // The Project and Vendor picklists are tallied off the rows this table was
  // handed, not the ledger-wide rosters: on one product's page the useful
  // question is "which projects/vendors bought THIS product", and offering the
  // other hundred would mostly be options that match nothing. Same option SHAPE
  // as the ledger's (`value` = id, `label` = name, count in `hint`).
  const rowProjectOptions = useMemo<FilterableComboboxItem[]>(() => {
    const byId = new Map<string, { name: string; count: number }>();
    for (const row of expenses) {
      if (!row.projectId || !row.projectName) continue;
      const seen = byId.get(row.projectId);
      if (seen) seen.count += 1;
      else byId.set(row.projectId, { name: row.projectName, count: 1 });
    }
    return [...byId]
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([id, { name, count }]) => ({
        value: id,
        label: name,
        hint: String(count),
      }));
  }, [expenses]);

  const rowVendorOptions = useMemo<FilterableComboboxItem[]>(() => {
    const byId = new Map<string, { name: string; count: number }>();
    for (const row of expenses) {
      if (!row.vendorId || !row.vendor) continue;
      const seen = byId.get(row.vendorId);
      if (seen) seen.count += 1;
      else byId.set(row.vendorId, { name: row.vendor, count: 1 });
    }
    return [...byId]
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([id, { name, count }]) => ({
        value: id,
        label: name,
        hint: String(count),
        icon: <VendorMark vendor={name} vendorId={id} />,
      }));
  }, [expenses]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mutation wrapper is functionally stable
  const columns = useMemo(
    () => [
      expenseDateColumn(helper, async (date, expense) => {
        if (date === null) return;
        await update.mutateAsync({ id: expense.id, data: { date } });
      }),
      createProjectLinkColumn(helper, {
        className: "w-40",
        filterConfig: manifestFilterConfig("expense", "project", {
          project: rowProjectOptions,
        }),
        editable: {
          onSave: async (projectId, expense) => {
            await update.mutateAsync({ id: expense.id, data: { projectId } });
          },
        },
      }),
      expenseVendorColumn(
        helper,
        async (vendor, expense) => {
          await update.mutateAsync({ id: expense.id, data: { vendor } });
        },
        { vendorOptions: rowVendorOptions },
      ),
      createTextColumn(helper, "orderId", {
        header: "Order #",
        className: "w-32 font-mono",
      }),
      expenseProductQuantityColumn(
        helper,
        async (productQuantity, expense) => {
          await update.mutateAsync({
            id: expense.id,
            data: { productQuantity },
          });
          setQuantityEditorExpenseId(null);
        },
        {
          autoOpen: (expense) => expense.id === quantityEditorExpenseId,
          id: (expense) => `${QUANTITY_TARGET_PREFIX}${expense.id}`,
        },
      ),
      expenseCostColumn(helper, async (cost, expense) => {
        await update.mutateAsync({ id: expense.id, data: { cost } });
      }),
      expenseTradeColumn(helper, async (trade, expense) => {
        await update.mutateAsync({ id: expense.id, data: { trade } });
      }),
      expenseCostTypeColumn(helper, async (costType, expense) => {
        await update.mutateAsync({ id: expense.id, data: { costType } });
      }),
      expenseLineKindColumn(helper, async (lineKind, expense) => {
        await update.mutateAsync({ id: expense.id, data: { lineKind } });
      }),
      expenseFutureColumn(helper, async (future, expense) => {
        await update.mutateAsync({ id: expense.id, data: { future } });
      }),
    ],
    [helper, quantityEditorExpenseId, rowProjectOptions, rowVendorOptions],
  );

  const { table, bulkActionBar, deleteDialog } =
    useClientEntityList<ExpenseOut>({
      entity: "expense",
      data: expenses,
      columns,
      nameEditable,
      deletable,
      bulkActions: bulkActions.config,
      tableStateOptions: EMBEDDED_TABLE_STATE,
      // Distinct column set from the /expenses ledger, so it needs its own
      // persisted View settings rather than sharing `table-columns:expense`.
      columnVisibilityScope: "product-detail",
      initialColumnVisibility: INITIAL_COLUMN_VISIBILITY,
      hiddenFilterColumns: SELF_FILTERED_COLUMNS,
    });

  if (isPending) return <Description>Loading expenses…</Description>;
  if (expenses.length === 0) {
    return (
      <ShelfEmpty
        entity="expense"
        // Don't claim the cost basis is missing when it isn't. A product priced
        // from a quote or invoice carries an explicit `priceOverride`, which
        // wins unconditionally over the derived aggregate and is what values
        // its inventory — so "link one to track this product's cost basis" was
        // false, and the action it invited is refused anyway on the orders this
        // most often applies to: an installment order's Expenses are
        // `lineBasis: "allocation"` and cannot carry a productId at all.
        label={
          product.pricing.source === "explicit" &&
          product.pricing.effectivePrice !== null
            ? `No expenses linked — cost basis is the manual price of ${formatCurrency(product.pricing.effectivePrice)}`
            : "No expenses linked — link one to track this product's cost basis"
        }
      />
    );
  }

  const split = splitExpenseSpend(expenses);
  const netCost = split.actual - split.contributions;
  const rollup = buildProjectRollup(expenses);
  const hasProjects = rollup.some((entry) => entry.projectId !== null);

  /**
   * Client pagination can put the prompted row on a later page, where
   * `scrollIntoView` would find no element — jump to its page first.
   */
  const openQuantityEditor = (expenseId: string) => {
    const rows = table.getSortedRowModel().flatRows;
    const index = rows.findIndex((row) => row.id === expenseId);
    if (index >= 0) {
      table.setPageIndex(
        Math.floor(index / table.getState().pagination.pageSize),
      );
    }
    setQuantityEditorExpenseId(expenseId);
  };

  return (
    <>
      <Stack gap="sm">
        <RTable
          table={table}
          ariaLabel={`${product.name} expense history`}
          entity="expense"
          sizingKey="expense:product-detail"
          bulkActionBar={bulkActionBar}
          embedded
          showColumnMenu
        />
        {hasProjects && (
          <Row wrap align="center" gap="sm" className="text-sm">
            <span className="text-muted-foreground">By project:</span>
            {rollup.map((entry) => (
              <Row
                key={entry.projectId ?? UNASSIGNED}
                align="center"
                gap="xs"
                className="min-w-0"
              >
                {entry.projectId && entry.projectName ? (
                  <EntityInlineLink
                    entity="project"
                    data={{ id: entry.projectId, name: entry.projectName }}
                    compact
                    truncate
                  />
                ) : (
                  <span className="text-muted-foreground">Unassigned</span>
                )}
                <Link
                  to="/expenses"
                  search={{
                    project: entry.projectId ?? FILTER_NONE,
                    productId: product.id,
                  }}
                  className="font-mono hover:underline"
                >
                  {formatCurrency(entry.net)}
                </Link>
              </Row>
            ))}
          </Row>
        )}
        <p className="text-muted-foreground text-sm">
          Net cost: <span className="font-mono">{formatCurrency(netCost)}</span>
          {split.contributions > 0 && (
            <>
              {" "}
              ({formatCurrency(split.actual)} spent −{" "}
              {formatCurrency(split.contributions)} recouped)
            </>
          )}
        </p>
        {product.pricing.derivedPrice !== null && (
          <p className="text-muted-foreground text-sm">
            Historical unit cost: {formatCurrency(product.pricing.derivedPrice)}
            {product.pricing.partial
              ? ` from ${product.pricing.knownExpenseCount} quantified expense${product.pricing.knownExpenseCount === 1 ? "" : "s"}`
              : ` across ${product.pricing.knownUnitCount} unit${product.pricing.knownUnitCount === 1 ? "" : "s"}`}
          </p>
        )}
        {product.pricing.unknownExpenseCount > 0 && (
          <button
            type="button"
            className="w-fit text-left text-sm text-warning hover:underline"
            onClick={() =>
              firstMissingAcquisition &&
              openQuantityEditor(firstMissingAcquisition.id)
            }
          >
            Add quantities to {product.pricing.unknownExpenseCount} acquisition
            {product.pricing.unknownExpenseCount === 1 ? "" : "s"} to derive a
            unit cost.
          </button>
        )}
        <Link
          to="/expenses"
          search={{ productId: product.id }}
          className="text-primary text-xs hover:underline"
        >
          See all in ledger →
        </Link>
      </Stack>
      {deleteDialog}
      <ExpenseBulkActionDialogs
        controller={bulkActions}
        onComplete={() => table.resetRowSelection()}
      />
    </>
  );
};

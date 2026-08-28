import type { ProductWithFoodOut } from "@cubby/schemas/product";
import type { KitMembershipOut } from "@cubby/schemas/product-components";
import type { ExpenseOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnVisibilityState as VisibilityState } from "@tanstack/react-table";
import { groupBy } from "es-toolkit";
import { type FC, useEffect, useMemo, useState } from "react";

import {
  createProjectLinkColumn,
  createTextColumn,
} from "~/app/_components/data-table/columnHelpers";
import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useClientEntityList } from "~/app/_components/hooks/useClientEntityList";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { expense } from "~/app/expenses/expense.functions";
import { product as productOperations } from "~/app/products/product.functions";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { FILTER_NONE } from "~/entities/filters";
import { formatCurrency } from "~/lib/utils";

import { createCubbyColumnHelper } from "../data-table/table-features";

const EMPTY_EXPENSES: ExpenseOut[] = [];
const EMPTY_MEMBERSHIP: KitMembershipOut[] = [];
const QUANTITY_TARGET_PREFIX = "product-expense-quantity-";

/** Read descriptors the history needs before it can choose its empty state. */
export interface ProductExpenseHistoryOperations {
  expenses: typeof expense.chartData;
  kitMembership: typeof productOperations.kitMembership;
}

const productionOperations: ProductExpenseHistoryOperations = {
  expenses: expense.chartData,
  kitMembership: productOperations.kitMembership,
};

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
export const ProductExpenseHistory: FC<{
  product: ProductWithFoodOut;
  operations?: ProductExpenseHistoryOperations;
}> = ({ product, operations = productionOperations }) => {
  const helper = useMemo(() => createCubbyColumnHelper<ExpenseOut>(), []);
  const [quantityEditorExpenseId, setQuantityEditorExpenseId] = useState<
    string | null
  >(null);
  const { data, isPending } = useQuery(
    operations.expenses.queryOptions({ productId: product.id }),
  );
  const expenses = data ?? EMPTY_EXPENSES;
  // Only consulted when `expenses` is empty (below) — a component of a kit
  // legitimately has zero Expenses of its own, and the generic "link one"
  // empty state is actively misleading there.
  const membershipQuery = useQuery(
    operations.kitMembership.queryOptions({ productId: product.id }),
  );
  const membership = membershipQuery.data ?? EMPTY_MEMBERSHIP;
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("expense", "update"),
    entity: "expense",
  });
  const nameEditable = useNameEditable<ExpenseOut>(update.mutateAsync);
  const deletable = useDeletableConfig({
    mutationFn: entityMutationOptionsFactory("expense", "delete"),
    entityLabel: "Expense",
    entity: "expense",
  });

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
    const byId = new Map<
      string,
      { name: string; count: number; logo: ExpenseOut["vendorLogo"] }
    >();
    for (const row of expenses) {
      if (!row.vendorId || !row.vendor) continue;
      const seen = byId.get(row.vendorId);
      if (seen) seen.count += 1;
      else
        byId.set(row.vendorId, {
          name: row.vendor,
          count: 1,
          logo: row.vendorLogo,
        });
    }
    return [...byId]
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([id, { name, count, logo }]) => ({
        value: id,
        label: name,
        hint: String(count),
        icon: <VendorMark vendor={name} vendorId={id} logo={logo} />,
      }));
  }, [expenses]);

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
    // oxlint-disable-next-line react/exhaustive-deps -- mutation wrapper is functionally stable
    [helper, quantityEditorExpenseId, rowProjectOptions, rowVendorOptions],
  );

  const { workbench } = useClientEntityList<ExpenseOut>({
    entity: "expense",
    data: expenses,
    columns,
    nameEditable,
    deletable,
    tableStateOptions: EMBEDDED_TABLE_STATE,
    // Distinct column set from the /expenses ledger, so it needs its own
    // persisted View settings rather than sharing `table-columns:expense`.
    layoutKey: "expense:product-detail",
    initialColumnVisibility: INITIAL_COLUMN_VISIBILITY,
    hiddenFilterColumns: SELF_FILTERED_COLUMNS,
  });
  const { table } = workbench;

  if (isPending) return <Description>Loading expenses…</Description>;
  if (expenses.length === 0) {
    // A component of a kit legitimately has zero Expenses of its own — the
    // kit keeps the one real Expense, and this component's price (shown
    // above) is a derived share of it, not spend. Wait on the membership
    // query too, so this doesn't flash the generic "link one" copy first.
    if (membershipQuery.isPending) {
      return <Description>Loading expenses…</Description>;
    }
    const [primaryKit, ...restKits] = membership;
    if (primaryKit) {
      return (
        <Empty variant="minimal" className="py-6">
          <EmptyHeader>
            <EmptyTitle>No expenses of its own</EmptyTitle>
            <EmptyDescription>
              This product is a component of{" "}
              <EntityInlineLink
                displayImage={undefined}
                entity="product"
                data={{
                  id: primaryKit.parentProductId,
                  name: primaryKit.parentProductName,
                  manufacturer: primaryKit.manufacturer,
                }}
                compact
              />
              {restKits.length > 0 &&
                ` (and ${restKits.length} other kit${restKits.length === 1 ? "" : "s"})`}
              . The kit carries the real Expense — this component's price is a
              derived share, not spend of its own.
            </EmptyDescription>
          </EmptyHeader>
          {primaryKit.expenseCount > 0 && (
            <Link
              to="/expenses"
              search={{ productId: primaryKit.parentProductId }}
              className="text-xs text-primary hover:underline"
            >
              See the kit's expenses →
            </Link>
          )}
        </Empty>
      );
    }
    return (
      <Empty variant="minimal" className="py-6">
        <EmptyHeader>
          <EmptyTitle>No expenses linked</EmptyTitle>
          <EmptyDescription>
            {
              // Don't claim the cost basis is missing when it isn't. A product
              // priced from a quote or invoice carries an explicit
              // `priceOverride`, which wins unconditionally over the derived
              // aggregate and is what values its inventory — so "link one to
              // track this product's cost basis" was false, and the action it
              // invited is refused anyway on the orders this most often
              // applies to: an installment order's Expenses are
              // `lineBasis: "allocation"` and cannot carry a productId at all.
              product.pricing.source === "explicit" &&
              product.pricing.effectivePrice !== null
                ? `Cost basis is the manual price of ${formatCurrency(product.pricing.effectivePrice)}.`
                : "Link one to track this product's cost basis."
            }
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
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
      table.setPageIndex(Math.floor(index / table.state.pagination.pageSize));
    }
    setQuantityEditorExpenseId(expenseId);
  };

  return (
    <Stack gap="sm">
      <ListWorkbench
        model={workbench}
        ariaLabel={`${product.name} expense history`}
        mode="embedded"
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
                  displayImage={undefined}
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
      <p className="text-sm text-muted-foreground">
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
        <p className="text-sm text-muted-foreground">
          Historical unit cost: {formatCurrency(product.pricing.derivedPrice)}
          {product.pricing.partial
            ? ` from ${product.pricing.knownExpenseCount} quantified expense${product.pricing.knownExpenseCount === 1 ? "" : "s"}`
            : ` across ${product.pricing.knownUnitCount} unit${product.pricing.knownUnitCount === 1 ? "" : "s"}`}
        </p>
      )}
      {product.pricing.unknownExpenseCount > 0 && (
        <button
          type="button"
          className="w-fit text-left text-sm text-warning-ink hover:underline"
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
        className="text-xs text-primary hover:underline"
      >
        See all in ledger →
      </Link>
    </Stack>
  );
};

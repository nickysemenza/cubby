import type { ProductWithFoodOut } from "@cubby/schemas/product";
import type { ExpenseOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { type FC, useEffect, useMemo, useState } from "react";
import {
  createNameColumn,
  createTextColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import {
  expenseCostColumn,
  expenseDateColumn,
  expenseProductQuantityColumn,
} from "~/app/projects/shared";
import { splitExpenseSpend } from "~/app/projects/spend";
import { VendorCell } from "~/components/entity/vendor-cell";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { expenseMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { ShelfEmpty } from "../data-table/shelf";

const EMPTY_EXPENSES: ExpenseOut[] = [];
const QUANTITY_TARGET_PREFIX = "product-expense-quantity-";

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: mutation wrapper is functionally stable
  const columns = useMemo(
    () => [
      expenseDateColumn(helper, async (date, expense) => {
        if (date === null) return;
        await update.mutateAsync({ id: expense.id, data: { date } });
      }),
      createNameColumn(helper, "expense", "name", {
        header: "Expense",
        editable: nameEditable,
      }),
      helper.accessor((expense) => expense.vendor, {
        id: "vendor",
        header: "Vendor",
        meta: { className: "w-40" },
        cell: (info) => {
          const expense = info.row.original;
          return expense.vendor ? (
            <VendorCell vendor={expense.vendor} vendorId={expense.vendorId} />
          ) : (
            <NoneValue />
          );
        },
      }),
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
    ],
    [helper, nameEditable, quantityEditorExpenseId],
  );
  const newestFirst = useMemo(() => [...expenses].reverse(), [expenses]);
  const table = useReactTable({
    data: newestFirst,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (expense) => expense.id,
  });

  if (isPending) return <Description>Loading expenses…</Description>;
  if (expenses.length === 0) {
    return (
      <ShelfEmpty
        entity="expense"
        label="No expenses linked — link one to track this product's cost basis"
      />
    );
  }

  const split = splitExpenseSpend(expenses);
  const netCost = split.actual - split.contributions;

  return (
    <Stack gap="sm">
      <RTable
        table={table}
        ariaLabel={`${product.name} expense history`}
        embedded
      />
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
            setQuantityEditorExpenseId(firstMissingAcquisition.id)
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
  );
};

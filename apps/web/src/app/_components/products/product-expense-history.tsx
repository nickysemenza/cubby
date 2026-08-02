import type { ProductWithFoodOut } from "@cubby/schemas/product";
import type { ExpenseOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { format } from "date-fns";
import type { FC } from "react";
import { splitExpenseSpend } from "~/app/projects/spend";
import { VendorCell } from "~/components/entity/vendor-cell";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useTRPC } from "~/integrations/trpc/react";
import { parsePlainDate } from "~/lib/plain-date";
import { formatCurrency } from "~/lib/utils";
import { ShelfEmpty } from "../data-table/shelf";
import { EntityInlineLink } from "../EntityInlineLink";

// Module-level so the fallback keeps a stable reference across renders.
const EMPTY_EXPENSES: ExpenseOut[] = [];

/**
 * Expense history for a product — every expense linked to it (arrivals
 * *and* dispositions, since a disposition is just a negative-cost expense on
 * the same product), newest first, plus the derived net cost.
 *
 * Reads `chartData`, not `list`: this renders a *money* total, and a paginated
 * read would silently drop rows from the sum past the page cap — the same trap
 * `chartData` was introduced for (see its doc comment in routers/expense.ts).
 * It returns date-ascending, so display reverses it.
 *
 * Net cost is `actual - contributions`, not `split.net` — `net` folds in
 * `committed` (future/planned rows), which is not money that has actually
 * moved for this product.
 */
export const ProductExpenseHistory: FC<{ product: ProductWithFoodOut }> = ({
  product,
}) => {
  const api = useTRPC();
  const { data, isPending } = useQuery(
    api.expense.chartData.queryOptions({ productId: product.id }),
  );
  const expenses = data ?? EMPTY_EXPENSES;

  // `isPending` gates the empty state: without it the "nothing linked" copy
  // flashes on every load, which reads as a wrong answer rather than a pending
  // one for a product that does have history.
  if (isPending) {
    return <Description>Loading expenses…</Description>;
  }

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
  const newestFirst = [...expenses].reverse();

  return (
    <Stack gap="sm">
      <Table className="table-auto">
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Expense</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>Order #</TableHead>
            <TableHead className="text-right">Quantity</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {newestFirst.map((expense) => (
            <TableRow key={expense.id}>
              <TableCell className="font-mono tabular-nums">
                {expense.date ? (
                  format(parsePlainDate(expense.date), "MMM d, yyyy")
                ) : (
                  <NoneValue />
                )}
              </TableCell>
              <TableCell>
                <EntityInlineLink entity="expense" data={expense} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {expense.vendor ? (
                  <VendorCell
                    vendor={expense.vendor}
                    vendorId={expense.vendorId}
                  />
                ) : (
                  <NoneValue />
                )}
              </TableCell>
              <TableCell className="font-mono">
                {expense.orderId ?? <NoneValue />}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {expense.productQuantity ?? <NoneValue />}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {expense.cost != null ? formatCurrency(expense.cost) : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
      {product.pricing.derivedPrice !== null ? (
        <p className="text-muted-foreground text-sm">
          Historical unit cost: {formatCurrency(product.pricing.derivedPrice)}
          {product.pricing.partial
            ? ` from ${product.pricing.knownExpenseCount} quantified expense${product.pricing.knownExpenseCount === 1 ? "" : "s"}; ${product.pricing.unknownExpenseCount} still missing quantity`
            : ` across ${product.pricing.knownUnitCount} unit${product.pricing.knownUnitCount === 1 ? "" : "s"}`}
        </p>
      ) : product.pricing.unknownExpenseCount > 0 ? (
        <p className="text-sm text-warning">
          Add quantities to {product.pricing.unknownExpenseCount} acquisition
          {product.pricing.unknownExpenseCount === 1 ? "" : "s"} to derive a
          unit cost.
        </p>
      ) : null}
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

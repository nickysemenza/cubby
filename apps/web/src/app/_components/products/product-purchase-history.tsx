import type { ProductWithFoodOut } from "@cubby/schemas/product";
import type { PurchaseOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import type { FC } from "react";
import { splitPurchaseSpend } from "~/app/projects/spend";
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
const EMPTY_PURCHASES: PurchaseOut[] = [];

/**
 * Purchase history for a product — every purchase linked to it (arrivals
 * *and* dispositions, since a disposition is just a negative-cost purchase on
 * the same product), newest first, plus the derived net cost.
 *
 * Reads `chartData`, not `list`: this renders a *money* total, and a paginated
 * read would silently drop rows from the sum past the page cap — the same trap
 * `chartData` was introduced for (see its doc comment in routers/purchase.ts).
 * It returns date-ascending, so display reverses it.
 *
 * Net cost is `actual - contributions`, not `split.net` — `net` folds in
 * `committed` (future/planned rows), which is not money that has actually
 * moved for this product.
 */
export const ProductPurchaseHistory: FC<{ product: ProductWithFoodOut }> = ({
  product,
}) => {
  const api = useTRPC();
  const { data, isPending } = useQuery(
    api.purchase.chartData.queryOptions({ productId: product.id }),
  );
  const purchases = data ?? EMPTY_PURCHASES;

  // `isPending` gates the empty state: without it the "nothing linked" copy
  // flashes on every load, which reads as a wrong answer rather than a pending
  // one for a product that does have history.
  if (isPending) {
    return <Description>Loading purchases…</Description>;
  }

  if (purchases.length === 0) {
    return (
      <ShelfEmpty
        entity="purchase"
        label="No purchases linked — link one to track this product's cost basis"
      />
    );
  }

  const split = splitPurchaseSpend(purchases);
  const netCost = split.actual - split.contributions;
  const newestFirst = [...purchases].reverse();

  return (
    <Stack gap="sm">
      <Table className="table-auto">
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Purchase</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {newestFirst.map((purchase) => (
            <TableRow key={purchase.id}>
              <TableCell className="font-mono tabular-nums">
                {purchase.date ? (
                  format(parsePlainDate(purchase.date), "MMM d, yyyy")
                ) : (
                  <NoneValue />
                )}
              </TableCell>
              <TableCell>
                <EntityInlineLink entity="purchase" data={purchase} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {purchase.vendor ?? <NoneValue />}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {purchase.cost != null ? formatCurrency(purchase.cost) : "—"}
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
    </Stack>
  );
};

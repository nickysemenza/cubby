import type { PurchaseOut } from "@cubby/schemas/purchase";
import type { VendorOut } from "@cubby/schemas/vendor";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import type { FC } from "react";
import { ShelfEmpty } from "~/app/_components/data-table/shelf";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
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

// Module-level so the fallback keeps a stable reference across renders.
const NO_PURCHASES: PurchaseOut[] = [];

/**
 * How many purchases the panel shows. A vendor detail page is wayfinding, not the
 * purchases index — the roster's Purchases count is the true total, and `/purchases`
 * filtered by vendor is where the full list lives.
 */
const PURCHASES_PAGE_SIZE = 25;

/**
 * A vendor's purchases — `purchase.list` scoped to this vendor, newest first
 * (that procedure's default sort is `date` desc).
 *
 * A static `<Table>`, not an `<RTable>`: nothing here sorts, filters or
 * paginates. Each row links to its own purchase — the "an embedded table must
 * reach its own rows' entity" rule — via `EntityInlineLink`, which owns the
 * (vendor, orderId, date) label ladder a purchase needs in place of a name.
 *
 * `expenseTotal` is the purchase's real spend; `statedTotal` is only what the
 * paperwork claimed, so both columns are shown and neither is summed into the
 * other. They legitimately disagree (a partial refund reduces a line without
 * changing what the purchase stated).
 */
export const VendorPurchasesTable: FC<{ vendor: VendorOut }> = ({ vendor }) => {
  const api = useTRPC();
  const { data, isPending } = useQuery(
    api.purchase.list.queryOptions({
      filters: { vendorId: vendor.id },
      pagination: { pageIndex: 0, pageSize: PURCHASES_PAGE_SIZE },
    }),
  );
  const purchases = data?.items ?? NO_PURCHASES;

  // `isPending` gates the empty state: without it "no purchases" flashes on every
  // load, which reads as an answer rather than a pending state.
  if (isPending) {
    return <Description>Loading purchases…</Description>;
  }

  if (purchases.length === 0) {
    return (
      <ShelfEmpty
        entity="purchase"
        label="No purchases yet — each purchase records one transaction at this vendor"
      />
    );
  }

  return (
    <Stack gap="sm">
      <Table className="table-auto">
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Purchase</TableHead>
            <TableHead className="text-right">Expenses</TableHead>
            <TableHead className="text-right">Stated</TableHead>
            <TableHead className="text-right">Expense total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {purchases.map((purchase) => (
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
              <TableCell className="text-right font-mono tabular-nums">
                {purchase.expenseCount}
              </TableCell>
              <TableCell className="text-right font-mono text-muted-foreground tabular-nums">
                {purchase.statedTotal != null ? (
                  formatCurrency(purchase.statedTotal)
                ) : (
                  <NoneValue />
                )}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatCurrency(purchase.expenseTotal)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {vendor.purchaseCount > purchases.length && (
        <Description>
          Showing the {purchases.length} most recent of {vendor.purchaseCount}{" "}
          purchases.
        </Description>
      )}
    </Stack>
  );
};

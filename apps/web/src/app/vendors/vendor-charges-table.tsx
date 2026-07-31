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
const NO_CHARGES: PurchaseOut[] = [];

/**
 * How many charges the panel shows. A vendor detail page is wayfinding, not the
 * charges index — the roster's Charges count is the true total, and `/purchases`
 * filtered by vendor is where the full list lives.
 */
const CHARGES_PAGE_SIZE = 25;

/**
 * A vendor's charges — `purchase.list` scoped to this vendor, newest first
 * (that procedure's default sort is `date` desc).
 *
 * A static `<Table>`, not an `<RTable>`: nothing here sorts, filters or
 * paginates. Each row links to its own charge — the "an embedded table must
 * reach its own rows' entity" rule — via `EntityInlineLink`, which owns the
 * (vendor, orderId, date) label ladder a charge needs in place of a name.
 *
 * `expenseTotal` is the charge's real spend; `statedTotal` is only what the
 * paperwork claimed, so both columns are shown and neither is summed into the
 * other. They legitimately disagree (a partial refund reduces a line without
 * changing what the charge stated).
 */
export const VendorChargesTable: FC<{ vendor: VendorOut }> = ({ vendor }) => {
  const api = useTRPC();
  const { data, isPending } = useQuery(
    api.purchase.list.queryOptions({
      filters: { vendorId: vendor.id },
      pagination: { pageIndex: 0, pageSize: CHARGES_PAGE_SIZE },
    }),
  );
  const charges = data?.items ?? NO_CHARGES;

  // `isPending` gates the empty state: without it "no charges" flashes on every
  // load, which reads as an answer rather than a pending state.
  if (isPending) {
    return <Description>Loading charges…</Description>;
  }

  if (charges.length === 0) {
    return (
      <ShelfEmpty
        entity="purchase"
        label="No charges yet — a purchase records one transaction at this vendor"
      />
    );
  }

  return (
    <Stack gap="sm">
      <Table className="table-auto">
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Charge</TableHead>
            <TableHead className="text-right">Lines</TableHead>
            <TableHead className="text-right">Stated</TableHead>
            <TableHead className="text-right">Line total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {charges.map((charge) => (
            <TableRow key={charge.id}>
              <TableCell className="font-mono tabular-nums">
                {charge.date ? (
                  format(parsePlainDate(charge.date), "MMM d, yyyy")
                ) : (
                  <NoneValue />
                )}
              </TableCell>
              <TableCell>
                <EntityInlineLink
                  entity="purchase"
                  data={{ ...charge, shortcode: charge.id }}
                />
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {charge.expenseCount}
              </TableCell>
              <TableCell className="text-right font-mono text-muted-foreground tabular-nums">
                {charge.statedTotal != null ? (
                  formatCurrency(charge.statedTotal)
                ) : (
                  <NoneValue />
                )}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatCurrency(charge.expenseTotal)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {vendor.purchaseCount > charges.length && (
        <Description>
          Showing the {charges.length} most recent of {vendor.purchaseCount}{" "}
          charges.
        </Description>
      )}
    </Stack>
  );
};

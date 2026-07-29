import type { PurchaseOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { format } from "date-fns";
import type { FC } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Description } from "~/components/ui/description";
import { FILTER_NONE } from "~/entities/filters";
import { useTRPC } from "~/integrations/trpc/react";
import { parsePlainDate } from "~/lib/plain-date";
import { formatCurrency } from "~/lib/utils";

// Module-level so the fallback keeps a stable reference across renders.
const EMPTY_SIBLINGS: PurchaseOut[] = [];

/**
 * "Same Order" — the other purchases sharing this one's vendor order id.
 *
 * Multi-row orders are the normal case, not an anomaly: an aggregate row
 * covering several export lines, siblings deliberately split one-per-product,
 * and a buy-and-return pair all put more than one row under one order id. This
 * section is where that grouping finally shows, and because it sums the order
 * it doubles as the reconciliation readout the purchase-import pass had to run
 * `GROUP BY vendor, orderId` by hand for.
 *
 * The header badge links to the same rows with the full ledger around them —
 * `order` + `vendor` together, because an order id only identifies an order
 * within one vendor. It resolves through the same `buildPurchaseWhereClause`
 * this list does, so the two can't disagree.
 */
export const PurchaseOrderSiblings: FC<{ purchase: PurchaseOut }> = ({
  purchase,
}) => {
  const api = useTRPC();
  const { data, isPending } = useQuery(
    api.purchase.orderSiblings.queryOptions(purchase.id),
  );
  const siblings = data ?? EMPTY_SIBLINGS;

  // `isPending` gates the empty state: without it "no other purchases" flashes
  // on every load, which reads as an answer rather than a pending state.
  if (isPending) {
    return <Description>Loading order…</Description>;
  }

  // The whole order, not just the siblings — this purchase is part of its own
  // order, and a total that excluded it would never reconcile against a receipt.
  const order = [purchase, ...siblings];
  const priced = order.filter((row) => row.cost != null);
  const total = priced.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const unpriced = order.length - priced.length;

  return (
    <Stack gap="sm">
      <Row align="baseline" justify="between" gap="sm">
        <Link
          to="/purchases"
          search={{
            order: purchase.orderId ?? undefined,
            // A null vendor is its own group, matching how the siblings were
            // resolved — `(none)` reads as `vendor IS NULL`, not "any vendor".
            vendor: purchase.vendor ?? FILTER_NONE,
          }}
        >
          {/* Opaque identifier, not a category — opts out of Badge's
              mono-uppercase stamp so the id reads exactly as stored. */}
          <Badge
            variant="outline"
            className="font-mono normal-case tracking-normal"
          >
            {purchase.orderId}
          </Badge>
        </Link>
        <span className="shrink-0 font-mono text-slate text-xs">
          {siblings.length} other{siblings.length === 1 ? "" : "s"}
        </span>
      </Row>

      {siblings.length === 0 ? (
        <Description>No other purchases share this order.</Description>
      ) : (
        <Stack gap="tight">
          {siblings.map((sibling) => (
            <Row key={sibling.id} align="center" justify="between" gap="sm">
              <EntityInlineLink entity="purchase" data={sibling} truncate />
              {sibling.date && (
                <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
                  {format(parsePlainDate(sibling.date), "MMM d, yyyy")}
                </span>
              )}
            </Row>
          ))}
        </Stack>
      )}

      <p className="border-[var(--border)] border-t pt-2 text-muted-foreground text-sm">
        {order.length} row{order.length === 1 ? "" : "s"} ·{" "}
        <span className="font-mono tabular-nums">{formatCurrency(total)}</span>
        {/* Called out rather than folded in as zero: an order that doesn't
            reconcile because a row has no cost recorded is a different
            problem from one that doesn't reconcile because a price is wrong. */}
        {unpriced > 0 && <> · {unpriced} without a cost</>}
      </p>
    </Stack>
  );
};

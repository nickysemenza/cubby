import type { ExpenseOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { ListFilter } from "lucide-react";
import type { FC } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { VendorCell } from "~/components/entity/vendor-cell";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import { entityDetailLink } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { parsePlainDate } from "~/lib/plain-date";
import { formatCurrency } from "~/lib/utils";

// Module-level so the fallback keeps a stable reference across renders.
const NO_OTHER_LINES: ExpenseOut[] = [];

/**
 * "This charge" — the transaction this expense line belongs to, and the other
 * lines filed under it.
 *
 * The grouping is a real parent link now (`expense.purchaseId → Purchase`), not
 * a `(vendor, orderId)` string match across ledger rows — so this section shows
 * whenever there IS a charge, not only when the vendor gave us an order id. A
 * third of vendor-bearing rows have no order id and those rows still belong to a
 * genuine transaction; under the old key they were invisible to each other, and
 * a Problems detector had to watch for lines of one order disagreeing on vendor.
 *
 * Multi-line charges are the normal case: an aggregate row covering several
 * export lines, siblings deliberately split one-per-product, and a
 * buy-and-return pair all sit under one charge. Because it sums the charge's
 * lines it doubles as the reconciliation readout the import pass used to run
 * `GROUP BY vendor, orderId` by hand for.
 */
export const ExpenseChargeSection: FC<{ expense: ExpenseOut }> = ({
  expense,
}) => {
  const api = useTRPC();
  // Called unconditionally, before the no-charge return below: `purchaseId` can
  // change under the same component instance (clearing a vendor detaches the
  // line), and a conditional hook would break the hook order when it does.
  const { data, isPending } = useQuery(
    api.expense.chargeSiblings.queryOptions(expense.id),
  );
  const others = data ?? NO_OTHER_LINES;

  // The caller only mounts this section for a line that has a charge; this keeps
  // the parent link's `params` honest rather than asserting a non-null id.
  if (!expense.purchaseId || !expense.purchaseShortcode) return null;

  // `isPending` gates the line list: without it "only line on this charge"
  // flashes on every load, which reads as an answer rather than a pending state.
  if (isPending) {
    return <Description>Loading charge…</Description>;
  }

  // The whole charge, not just the other lines — this expense is one of them,
  // and a total that excluded it would never reconcile against a receipt.
  const lines = [expense, ...others];
  const priced = lines.filter((line) => line.cost != null);
  const total = priced.reduce((sum, line) => sum + (line.cost ?? 0), 0);
  const unpriced = lines.length - priced.length;

  return (
    <Stack gap="sm">
      <Row align="center" justify="between" gap="sm">
        <Row align="center" gap="sm" className="min-w-0">
          {/* The charge's own page is the primary hop — it owns the invoice,
              the stated total, and every line at once. */}
          <Link
            {...entityDetailLink("purchase", expense.purchaseShortcode)}
            className="min-w-0 hover:underline"
          >
            {expense.vendor ? (
              <VendorCell vendor={expense.vendor} vendorId={expense.vendorId} />
            ) : (
              <span className="truncate">View charge</span>
            )}
          </Link>
          {/* Secondary: the rest of this vendor's spend in the ledger. `vendor`
              is the URL key and now carries the vendor ID (same shape as
              `?project=`), which is what the id-based filter matches on. */}
          {expense.vendorId && (
            <Link
              to="/expenses"
              search={{ vendor: expense.vendorId }}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={`Show every ledger line from ${expense.vendor ?? "this vendor"}`}
            >
              <ListFilter className="size-3.5" />
            </Link>
          )}
        </Row>
        {/* Opaque identifier, not a category — opts out of Badge's
            mono-uppercase stamp so the id reads exactly as stored. Absent on
            plenty of real charges (cash at the yard, a contractor's invoice). */}
        {expense.orderId ? (
          <Badge
            variant="outline"
            className="shrink-0 font-mono normal-case tracking-normal"
          >
            {expense.orderId}
          </Badge>
        ) : (
          // A predicate about the charge, not an identifier — the eyebrow
          // register (mono/uppercase/slate) rather than a Badge, so it doesn't
          // read as an order id that happens to say "none".
          <span className="shrink-0 font-mono text-slate text-xs uppercase tracking-wider">
            no order id
          </span>
        )}
      </Row>

      {others.length === 0 ? (
        <Description>This is the only line on the charge.</Description>
      ) : (
        <Stack gap="tight">
          {others.map((line) => (
            <Row key={line.id} align="center" justify="between" gap="sm">
              <EntityInlineLink entity="expense" data={line} truncate />
              <Row
                align="center"
                gap="sm"
                className="shrink-0 font-mono text-xs tabular-nums"
              >
                {line.date && (
                  <span className="text-muted-foreground">
                    {format(parsePlainDate(line.date), "MMM d, yyyy")}
                  </span>
                )}
                {line.cost != null ? formatCurrency(line.cost) : <NoneValue />}
              </Row>
            </Row>
          ))}
        </Stack>
      )}

      <p className="border-[var(--border)] border-t pt-2 text-muted-foreground text-sm">
        {lines.length} line{lines.length === 1 ? "" : "s"} ·{" "}
        <span className="font-mono tabular-nums">{formatCurrency(total)}</span>
        {/* Called out rather than folded in as zero: a charge that doesn't
            reconcile because a line has no cost recorded is a different
            problem from one that doesn't reconcile because a price is wrong. */}
        {unpriced > 0 && <> · {unpriced} without a cost</>}
      </p>
    </Stack>
  );
};

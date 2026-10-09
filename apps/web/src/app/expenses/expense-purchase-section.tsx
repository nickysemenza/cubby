import type { ExpenseOut } from "@cubby/schemas/project";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, type FC } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/entity/entity-media/entity-display-images";
import { expense as expenseOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCalendarDay } from "~/lib/date-format";
import { formatCurrency } from "~/lib/utils";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { NoneValue } from "~/ui/primitives/none-value";

// Module-level so the fallback keeps a stable reference across renders.
const NO_OTHER_EXPENSES: ExpenseOut[] = [];

type ChargeContextQuery = ReturnType<
  typeof expenseOperations.chargeContext.queryOptions
>;

export interface ExpensePurchaseOperations {
  chargeContext: (expenseId: ExpenseOut["id"]) => ChargeContextQuery;
}

interface ExpensePurchaseSectionProps {
  expense: ExpenseOut;
  operations?: ExpensePurchaseOperations;
  /**
   * The purchase total line ("3 expenses · $50.00 · 1 without a cost"), as the section read
   * words it. Summed on the server so every client reconciles to the same figure.
   */
  summaryLine?: string | null;
  /** What to say when this line is the only one in its purchase. */
  soloNote?: string | null;
}

const productionOperations: ExpensePurchaseOperations = {
  chargeContext: expenseOperations.chargeContext.queryOptions,
};

/**
 * "This purchase" — the transaction this expense line belongs to, and the other
 * lines filed under it.
 *
 * The grouping is a real parent link now (`expense.purchaseId → Purchase`), not
 * a `(vendor, orderId)` string match across ledger rows — so this section shows
 * whenever there IS a purchase, not only when the vendor gave us an order id. A
 * third of vendor-bearing rows have no order id and those rows still belong to a
 * genuine transaction; under the old key they were invisible to each other, and
 * a Problems detector had to watch for lines of one order disagreeing on vendor.
 *
 * Multi-line purchases are the normal case: an aggregate row covering several
 * export lines, siblings deliberately split one-per-product, and a
 * buy-and-return pair all sit under one purchase. The server sums the purchase's
 * lines into `summaryLine`, so it doubles as the reconciliation readout the
 * import pass used to run `GROUP BY vendor, orderId` by hand for.
 */
export const ExpensePurchaseSection: FC<ExpensePurchaseSectionProps> = ({
  expense,
  operations = productionOperations,
  summaryLine = null,
  soloNote = null,
}) => {
  // Called unconditionally, before the no-purchase return below: `purchaseId` can
  // change under the same component instance (clearing a vendor detaches the
  // Expense), and a conditional hook would break the hook order when it does.
  const { data, isPending, isError, error, isFetching, refetch } = useQuery(
    operations.chargeContext(expense.id),
  );
  const others = data?.siblings ?? NO_OTHER_EXPENSES;
  const imageRefs = useMemo(
    () => [
      ...(data?.purchase
        ? [{ entityKind: "purchase" as const, entityId: data.purchase.id }]
        : []),
      ...others.map((line) => ({
        entityKind: "expense" as const,
        entityId: line.id,
      })),
    ],
    [data?.purchase, others],
  );
  const displayImages = useEntityDisplayImages(imageRefs);

  // The caller only mounts this section for an Expense that has a Purchase; this keeps
  // the parent link's `params` honest rather than asserting a non-null id.
  // `purchaseId` is the purchase's shortcode (per the purchase shortcode cutover).
  if (!expense.purchaseId) return null;

  // `isPending` gates the Expense list: without it "only Expense in this Purchase"
  // flashes on every load, which reads as an answer rather than a pending state.
  if (isPending) {
    return <Description>Loading purchase…</Description>;
  }

  if (isError) {
    return (
      <Stack gap="sm">
        <ErrorDisplay error={error} title="the purchase items" />
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          Retry purchase items
        </Button>
      </Stack>
    );
  }

  // The expense can be detached (or its purchase deleted) after this detail
  // payload was fetched. Do not render a stale purchase link in that window.
  if (!data) return null;

  return (
    <Stack gap="sm">
      <Row align="center" gap="sm" className="min-w-0">
        {/* The purchase's own page is the primary hop — it owns the invoice,
            stated total, and every Expense at once. Its canonical identity comes
            from Purchase, including the purchase date (not this Expense's ledger
            date), so the shared purchase-label ladder stays truthful. */}
        <EntityRefLink
          displayImage={
            displayImages[
              entityDisplayImageKey({
                entityKind: "purchase",
                entityId: data.purchase.id,
              })
            ] ?? null
          }
          entity="purchase"
          data={data.purchase}
          truncate
        />
        {/* Secondary: the rest of this vendor's spend in the ledger. `vendor`
            is the URL key and carries the vendor shortcode (same shape as
            `?project=`), which is what the id-based filter matches on. */}
        <Link
          to="/expenses"
          search={{ vendor: data.purchase.vendorId }}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Show every Expense from ${data.purchase.vendorName ?? "this vendor"}`}
        >
          <FunnelIcon className="size-3.5" />
        </Link>
      </Row>

      {others.length === 0 ? (
        soloNote ? (
          <Description>{soloNote}</Description>
        ) : null
      ) : (
        <Stack gap="tight">
          {others.map((line) => (
            <Row key={line.id} align="center" justify="between" gap="sm">
              <EntityRefLink
                displayImage={
                  displayImages[
                    entityDisplayImageKey({
                      entityKind: "expense",
                      entityId: line.id,
                    })
                  ] ?? null
                }
                entity="expense"
                data={line}
                truncate
              />
              <Row
                align="center"
                gap="sm"
                className="shrink-0 font-mono text-xs tabular-nums"
              >
                {line.date && (
                  <span className="text-muted-foreground">
                    {formatCalendarDay(line.date, "dateShort")}
                  </span>
                )}
                {line.cost != null ? formatCurrency(line.cost) : <NoneValue />}
              </Row>
            </Row>
          ))}
        </Stack>
      )}

      {summaryLine ? (
        <p className="border-t border-[var(--border)] pt-2 text-sm text-muted-foreground">
          {summaryLine}
        </p>
      ) : null}
    </Stack>
  );
};

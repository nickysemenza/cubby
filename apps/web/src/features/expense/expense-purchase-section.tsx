import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, type FC } from "react";
import { z } from "zod";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { recordTypeCode } from "~/entity/components/record-pill-identity";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/entity/entity-media/entity-display-images";
import { readRecordField } from "~/entity/entity-references";
import { expense as expenseOperations } from "~/integrations/tanstack-query/generated/domains/expense.gen";
import { formatCurrency } from "~/lib/number-format";
import { FieldRecordValue } from "~/ui/derived/record-value";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { RecordList, RecordRow, RecordTotal } from "~/ui/records/record-list";
import { RecordPillHost } from "~/ui/records/record-pill";
import { Description } from "~/ui/text/description";
import { NoneValue } from "~/ui/text/none-value";
import { DateDisplay } from "~/ui/values/date-display";

const SIBLING_COLUMNS = [
  { id: "date", label: "Date" },
  { id: "amount", label: "Amount" },
] as const;

const EXPENSE_TYPE = recordTypeCode("expense");

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
  const effectiveExpensePurchaseId = fieldValueOf(expense.fields.purchaseId);

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
  if (!effectiveExpensePurchaseId) return null;

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
  const vendorId = fieldValueOf(data.purchase.fields.vendorId);

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
        />
        {/* Secondary: the rest of this vendor's spend in the ledger. `vendor`
            is the URL key and carries the vendor shortcode (same shape as
            `?project=`), which is what the id-based filter matches on. */}
        <FieldRecordValue record={data.purchase} field="vendorId">
          {vendorId ? (
            <Link
              to="/expenses"
              search={{ vendor: vendorId }}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={`Show every Expense from ${data.purchase.vendorName ?? "this vendor"}`}
            >
              <FunnelIcon className="size-3.5" />
            </Link>
          ) : (
            <NoneValue />
          )}
        </FieldRecordValue>
      </Row>

      {others.length === 0 ? (
        soloNote ? (
          <Description>{soloNote}</Description>
        ) : null
      ) : (
        <SiblingExpenses
          lines={others}
          displayImages={displayImages}
          summaryLine={summaryLine}
        />
      )}

      {others.length === 0 && summaryLine ? (
        <p className="border-t border-[var(--border)] pt-2 text-sm text-muted-foreground">
          {summaryLine}
        </p>
      ) : null}
    </Stack>
  );
};

const beneficiaryPortions = z
  .array(z.looseObject({ partyName: z.string().nullable() }))
  .nullish()
  .catch(null);

/** Who the line is for, as the server resolved it; blank when nobody is named. */
const beneficiaryNames = (line: ExpenseOut) =>
  (readRecordField(line, "effectiveBeneficiaries", beneficiaryPortions) ?? [])
    .flatMap((portion) => (portion.partyName ? [portion.partyName] : []))
    .join(", ");

/** The purchase's other lines as a column ledger. */
function SiblingExpenses({
  lines,
  displayImages,
  summaryLine,
}: {
  lines: readonly ExpenseOut[];
  displayImages: ReturnType<typeof useEntityDisplayImages>;
  summaryLine: string | null;
}) {
  return (
    // The header names the vendor and the columns hold the facts, so each
    // row's pill is only the part of its title that differs.
    <RecordPillHost host="columns">
      <RecordList
        aria-label="Other expenses in this purchase"
        columns={SIBLING_COLUMNS}
      >
        {lines.map((line) => (
          <RecordRow
            key={line.id}
            // The person leads: sibling lines of one booking differ by who
            // they are for long before their titles do.
            leading={
              <span className="flex items-center gap-2 text-xs">
                <span className="font-mono text-muted-foreground">
                  {EXPENSE_TYPE}
                </span>
                <span className="font-medium text-foreground">
                  {beneficiaryNames(line)}
                </span>
              </span>
            }
            primary={
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
              />
            }
            facts={[
              ...(line.date
                ? [
                    {
                      id: "date",
                      label: "Date",
                      value: <DateDisplay start={line.date} />,
                    },
                  ]
                : []),
              {
                id: "amount",
                label: "Amount",
                className: "text-right font-mono tabular-nums",
                tone:
                  line.cost != null && line.cost < 0
                    ? ("destructive" as const)
                    : undefined,
                value:
                  line.cost != null ? formatCurrency(line.cost) : <NoneValue />,
              },
            ]}
          />
        ))}
        {summaryLine ? <RecordTotal>{summaryLine}</RecordTotal> : null}
      </RecordList>
    </RecordPillHost>
  );
}

type ExpenseOut = DetailRecordOf<"expense">;

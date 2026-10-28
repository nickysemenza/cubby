import {
  COST_TYPE_LABELS,
  type CostType,
  costTypeValues,
} from "@cubby/schemas/expense-fields";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type {
  FinancialBookingPreview,
  FinancialBookingInput,
} from "@cubby/schemas/financial-booking";
import type { ShortcodeFor } from "@cubby/schemas/identifiers";
import { TRADE_LABELS } from "@cubby/schemas/project";
import { type Trade, tradeSchema } from "@cubby/schemas/task-fields";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { EntityReferencePicker } from "~/entity/picker/entity-reference-picker";
import { Picker } from "~/entity/picker/picker";
import { WithVendorShortcodeSearch } from "~/entity/picker/with-vendor-search";
import { tradeOptions } from "~/entity/presentation/trade-options";
import { financialTransaction } from "~/integrations/tanstack-query/generated/catalog/financialTransaction.gen";
import { formatCurrency } from "~/lib/number-format";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { FieldValueMark } from "~/ui/derived/value-mark";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

const CREDIT_PURPOSE_OPTIONS: readonly PickerOption[] = [
  { value: "vendor", label: "Vendor refund or proceeds" },
  { value: "reimbursement", label: "Friend reimbursement" },
];

const COST_TYPE_OPTIONS: readonly PickerOption[] = costTypeValues.map(
  (value) => ({ value, label: COST_TYPE_LABELS[value] }),
);

function expectsBookingReview(transaction: FinancialTransactionOut) {
  const effectiveTransactionCoverage = fieldValueOf(
    transaction.fields.coverage,
  );

  return (
    (effectiveTransactionCoverage !== null &&
      ["missing", "partial"].includes(effectiveTransactionCoverage.booking)) ||
    (transaction.kind === "income" &&
      transaction.amount < 0 &&
      transaction.allocations.length === 0)
  );
}
function BookingPreviewDetails({
  review,
  vendorName,
}: {
  review: FinancialBookingPreview;
  vendorName?: string;
}) {
  return (
    <>
      {review.vendorId ? (
        <p className="text-sm">
          Vendor:{" "}
          <EntityRefLink
            entity="vendor"
            id={review.vendorId}
            name={vendorName ?? review.vendorId}
          />
          {review.confirmsMerchant === false ? (
            <span className="ml-1 text-xs text-muted-foreground">
              identified from evidence
            </span>
          ) : null}
        </p>
      ) : null}
      <p className="text-sm">
        {review.action === "link_existing"
          ? "Link existing Expenses to"
          : "Record"}{" "}
        {formatCurrency(review.amount)} on {review.date} as{" "}
        {review.economicRole === "reimbursement"
          ? "a reimbursement credit"
          : "spending"}
        . Receipt lines remain separate evidence.
      </p>
      <p className="text-xs text-muted-foreground">
        {review.accountName} ·{" "}
        {review.funderName ?? "No account owner recorded"} · Cost type:{" "}
        {COST_TYPE_LABELS[review.costType]} · Trade:{" "}
        {TRADE_LABELS[review.trade]} · Already booked:{" "}
        {formatCurrency(review.existingBookedAmount)}
      </p>
    </>
  );
}
export function FinancialBookingReview({
  transaction,
}: {
  transaction: FinancialTransactionOut;
}) {
  const [category, setCategory] = useState<ComboboxItem<
    ShortcodeFor<"spendingCategory">
  > | null>(null);
  const [vendor, setVendor] = useState<ComboboxItem<
    ShortcodeFor<"vendor">
  > | null>(null);
  const [purchase, setPurchase] = useState<ComboboxItem<
    ShortcodeFor<"purchase">
  > | null>(null);
  const [role, setRole] = useState<"vendor" | "reimbursement">("vendor");
  // Regression: the request hard-coded Trade "other" and Cost type
  // "materials", so every booked Expense landed with those regardless of what
  // it was.
  const [trade, setTrade] = useState<Trade>("other");
  const [costType, setCostType] = useState<CostType>("materials");
  const [review, setReview] = useState<FinancialBookingPreview | null>(null);
  const preview = useMutation({
    mutationFn: (input: FinancialBookingInput) =>
      financialTransaction.previewBooking.call(input),
  });
  const commit = useMutation(
    financialTransaction.commitBooking.mutationOptions(),
  );
  if (!expectsBookingReview(transaction)) return null;
  const categoryId = category?.id ?? null;
  const inference = fieldValueOf(transaction.fields.vendorInference);
  const identifiedVendor =
    inference?.status === "suggested" ? inference.candidates[0] : null;
  const busy = preview.isPending || commit.isPending;
  return (
    <Stack gap="sm">
      <p className="text-sm text-muted-foreground">
        Review this spending before recording it as an Expense.
      </p>
      <EntityReferencePicker
        entity="spendingCategory"
        label="Spending category"
        value={category}
        setValue={(item) => {
          setCategory(item);
          setReview(null);
        }}
        placeholder="Choose spending category"
        disabled={busy}
      />
      <EntityReferencePicker
        entity="purchase"
        label="Existing purchase"
        value={purchase}
        setValue={(item) => {
          setPurchase(item);
          setReview(null);
        }}
        placeholder="Link an existing purchase (optional)"
        clearable
        disabled={busy}
      />
      {!purchase ? (
        <Stack gap="tight">
          <WithVendorShortcodeSearch>
            {(search) => (
              <Picker
                {...search}
                entity="vendor"
                label="Vendor"
                value={vendor}
                setValue={(item) => {
                  setVendor(item);
                  setReview(null);
                }}
                placeholder="Choose vendor for a new purchase"
                disabled={busy}
              />
            )}
          </WithVendorShortcodeSearch>
          {!vendor && identifiedVendor ? (
            <Row gap="sm" className="text-xs">
              <FieldValueMark envelope={transaction.fields.vendorInference}>
                <EntityRefLink
                  entity="vendor"
                  id={identifiedVendor.vendorId}
                  name={identifiedVendor.vendorName}
                />
              </FieldValueMark>
              <span className="text-muted-foreground">
                From confirmed statement history
              </span>
            </Row>
          ) : !vendor && inference?.status === "ambiguous" ? (
            <p className="text-xs text-muted-foreground">
              This statement label identifies several Vendors. Choose the Vendor
              or an existing Purchase.
            </p>
          ) : null}
        </Stack>
      ) : null}
      <Row gap="sm" className="flex-wrap">
        <Picker
          mode="choose"
          label="Trade"
          options={tradeOptions}
          value={trade}
          onValueChange={(next) => {
            const parsed = tradeSchema.safeParse(next);
            if (parsed.success) setTrade(parsed.data);
            setReview(null);
          }}
          disabled={busy}
        />
        <Picker
          mode="choose"
          label="Cost type"
          options={COST_TYPE_OPTIONS}
          value={costType}
          onValueChange={(next) => {
            const match = costTypeValues.find((value) => value === next);
            if (match) setCostType(match);
            setReview(null);
          }}
          disabled={busy}
        />
      </Row>
      {transaction.amount < 0 ? (
        <Picker
          mode="choose"
          label="Credit purpose"
          options={CREDIT_PURPOSE_OPTIONS}
          value={role}
          onValueChange={(next) => {
            setRole(next === "reimbursement" ? "reimbursement" : "vendor");
            setReview(null);
          }}
          disabled={busy}
        />
      ) : null}
      {preview.error || commit.error ? (
        <ErrorDisplay error={preview.error ?? commit.error} />
      ) : null}
      {review ? (
        <Stack gap="tight">
          <BookingPreviewDetails
            review={review}
            vendorName={vendor?.name ?? identifiedVendor?.vendorName}
          />
          <Row gap="sm">
            <Button
              onClick={() =>
                commit.mutate(review, { onSuccess: () => setReview(null) })
              }
              disabled={busy}
            >
              {commit.isPending
                ? "Recording…"
                : review.action === "link_existing"
                  ? "Link settlement"
                  : "Record Expense"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setReview(null)}
              disabled={busy}
            >
              Back
            </Button>
          </Row>
        </Stack>
      ) : (
        <Button
          variant="outline"
          disabled={
            busy ||
            (!categoryId && !purchase) ||
            (!purchase && !vendor && !identifiedVendor)
          }
          onClick={() => {
            if (categoryId || purchase)
              preview.mutate(
                {
                  transactionId: transaction.id,
                  purchaseId: purchase?.id ?? null,
                  vendorId: vendor?.id ?? null,
                  spendingCategoryId: categoryId ?? null,
                  purchaserId: null,
                  economicRole: role,
                  trade,
                  costType,
                },
                { onSuccess: setReview },
              );
          }}
        >
          {preview.isPending ? "Preparing…" : "Review Expense"}
        </Button>
      )}
    </Stack>
  );
}

type FinancialTransactionOut = DetailRecordOf<"financialTransaction">;

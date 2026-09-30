import type {
  FinancialBookingPreview,
  FinancialBookingInput,
} from "@cubby/schemas/financial-booking";
import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import type { ShortcodeFor } from "@cubby/schemas/identifiers";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { EntityReferencePicker } from "~/app/_components/combobox/entity-reference-picker";
import { WithVendorShortcodeSearch } from "~/app/_components/combobox/with-vendor-search";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NativeSelect } from "~/components/ui/native-select";
import { financialTransaction } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/utils";

function expectsBookingReview(transaction: FinancialTransactionOut) {
  return (
    ["missing", "partial"].includes(transaction.coverage.booking) ||
    (transaction.kind === "income" &&
      transaction.amount < 0 &&
      transaction.allocations.length === 0)
  );
}
function BookingPreviewDetails({
  review,
}: {
  review: FinancialBookingPreview;
}) {
  return (
    <>
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
        {review.costType} · Trade: {review.trade} · Already booked:{" "}
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
  const [review, setReview] = useState<FinancialBookingPreview | null>(null);
  const preview = useMutation({
    mutationFn: (input: FinancialBookingInput) =>
      financialTransaction.previewBooking.call(input),
  });
  const commit = useMutation(
    financialTransaction.commitBooking.mutationOptions(),
  );
  if (!expectsBookingReview(transaction)) return null;
  const categoryId = category?.id ?? transaction.spendingCategoryId;
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
        <WithVendorShortcodeSearch>
          {(search) => (
            <EntityPicker
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
      ) : null}
      {transaction.amount < 0 ? (
        <NativeSelect
          aria-label="Credit purpose"
          value={role}
          onChange={(event) => {
            setRole(
              event.target.value === "reimbursement"
                ? "reimbursement"
                : "vendor",
            );
            setReview(null);
          }}
          disabled={busy}
        >
          <option value="vendor">Vendor refund or proceeds</option>
          <option value="reimbursement">Friend reimbursement</option>
        </NativeSelect>
      ) : null}
      {preview.error || commit.error ? (
        <ErrorDisplay error={preview.error ?? commit.error} />
      ) : null}
      {review ? (
        <Stack gap="tight">
          <BookingPreviewDetails review={review} />
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
            busy || (!categoryId && !purchase) || (!purchase && !vendor)
          }
          onClick={() => {
            if (categoryId || purchase)
              preview.mutate(
                {
                  transactionId: transaction.id,
                  purchaseId: purchase?.id ?? null,
                  vendorId: vendor?.id ?? null,
                  spendingCategoryId: categoryId ?? null,
                  economicRole: role,
                  trade: "other",
                  costType: "materials",
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

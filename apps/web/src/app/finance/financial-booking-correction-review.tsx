import type {
  FinancialBookingCorrectionInput,
  FinancialBookingCorrectionPreview,
} from "@cubby/schemas/financial-booking";
import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import type { ShortcodeFor } from "@cubby/schemas/identifiers";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityReferencePicker } from "~/app/_components/combobox/entity-reference-picker";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NativeSelect } from "~/components/ui/native-select";
import { financialTransaction } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/utils";

export function FinancialBookingCorrectionReview({
  transaction,
}: {
  transaction: FinancialTransactionOut;
}) {
  const [kind, setKind] = useState<
    "attach_reimbursement" | "convert_to_transfer"
  >(transaction.amount < 0 ? "attach_reimbursement" : "convert_to_transfer");
  const [purchase, setPurchase] = useState<ComboboxItem<
    ShortcodeFor<"purchase">
  > | null>(null);
  const [transfer, setTransfer] = useState<ComboboxItem<
    ShortcodeFor<"ledgerTransfer">
  > | null>(null);
  const [review, setReview] =
    useState<FinancialBookingCorrectionPreview | null>(null);
  const preview = useMutation({
    mutationFn: (input: FinancialBookingCorrectionInput) =>
      financialTransaction.previewBookingCorrection.call(input),
  });
  const commit = useMutation(
    financialTransaction.commitBookingCorrection.mutationOptions(),
  );
  if (
    transaction.coverage.booking !== "recorded" ||
    transaction.ledgerTransferId
  )
    return null;
  const busy = preview.isPending || commit.isPending;
  return (
    <Stack gap="sm">
      <NativeSelect
        aria-label="Booking correction"
        value={kind}
        onChange={(event) => {
          setKind(
            event.target.value === "attach_reimbursement"
              ? "attach_reimbursement"
              : "convert_to_transfer",
          );
          setReview(null);
        }}
        disabled={busy}
      >
        {transaction.amount < 0 ? (
          <option value="attach_reimbursement">
            Attach reimbursement to original purchase
          </option>
        ) : null}
        <option value="convert_to_transfer">
          Convert booked spending to transfer evidence
        </option>
      </NativeSelect>
      {kind === "attach_reimbursement" ? (
        <EntityReferencePicker
          entity="purchase"
          label="Original purchase"
          value={purchase}
          setValue={(item) => {
            setPurchase(item);
            setReview(null);
          }}
          placeholder="Choose original purchase"
          disabled={busy}
        />
      ) : (
        <EntityReferencePicker
          entity="ledgerTransfer"
          label="Transfer"
          value={transfer}
          setValue={(item) => {
            setTransfer(item);
            setReview(null);
          }}
          placeholder="Choose recorded transfer"
          disabled={busy}
        />
      )}
      {preview.error || commit.error ? (
        <ErrorDisplay error={preview.error ?? commit.error} />
      ) : null}
      {review ? (
        <Stack gap="tight">
          <p className="text-sm">
            {review.action.kind === "convert_to_transfer"
              ? "Retire these booked Expenses and attach their bank evidence to"
              : "Move these reimbursement Expenses and their bank evidence to"}{" "}
            {review.targetName}.
          </p>
          {review.action.kind === "attach_reimbursement" ? (
            <p className="text-xs text-muted-foreground">
              Inherit category: {review.categoryName} · Purchase project
              default: {review.projectName ?? "None"} · Purchase trade default:{" "}
              {review.trade ?? "None"}. Existing Expense project and trade
              overrides stay recorded.
            </p>
          ) : null}
          {review.lines.map((line) => (
            <p key={line.expenseId} className="text-sm">
              {line.title} · {formatCurrency(line.amount)}
              {line.notes ? ` · ${line.notes}` : ""}
            </p>
          ))}
          <Row gap="sm">
            <Button
              disabled={busy}
              onClick={() =>
                commit.mutate(review, { onSuccess: () => setReview(null) })
              }
            >
              {commit.isPending ? "Applying…" : "Apply reviewed correction"}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              Back
            </Button>
          </Row>
        </Stack>
      ) : (
        <Button
          variant="outline"
          disabled={
            busy || (kind === "attach_reimbursement" ? !purchase : !transfer)
          }
          onClick={() => {
            const action =
              kind === "attach_reimbursement" && purchase
                ? {
                    kind: "attach_reimbursement" as const,
                    purchaseId: purchase.id,
                  }
                : kind === "convert_to_transfer" && transfer
                  ? {
                      kind: "convert_to_transfer" as const,
                      transferId: transfer.id,
                    }
                  : null;
            if (action)
              preview.mutate(
                { transactionId: transaction.id, action },
                { onSuccess: setReview },
              );
          }}
        >
          {preview.isPending ? "Preparing…" : "Review booking correction"}
        </Button>
      )}
    </Stack>
  );
}

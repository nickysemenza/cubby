import type { FinancialTransferPairSuggestionsOut } from "@cubby/schemas/household-contribution";
import { financialTransactionShortcode } from "@cubby/schemas/identifiers";
import { useMutation, useQuery } from "@tanstack/react-query";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  WorkActionDialogTrigger,
  type WorkActionProps,
} from "~/entity/work-queue/work-actions";
import { financialTransaction } from "~/integrations/tanstack-query/generated/domains/financialTransaction.gen";
import { householdContribution } from "~/integrations/tanstack-query/generated/domains/householdContribution.gen";
import { formatCurrency } from "~/lib/number-format";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";

type Candidate =
  FinancialTransferPairSuggestionsOut["suggestions"][number]["candidates"][number];

/**
 * Suggested counterpart legs for one account transfer, each with Accept. A
 * refusal shows the server's raw reason; the household is trusted.
 */
export function TransferPairAccept({
  transactionId,
}: {
  transactionId: string;
}) {
  const pairs = useQuery(
    householdContribution.transferPairs.queryOptions({
      transactionIds: [financialTransactionShortcode.parse(transactionId)],
    }),
  );
  if (pairs.isError)
    return <ErrorDisplay error={pairs.error} title="Transfer pairs" />;
  const candidates =
    pairs.data?.suggestions.flatMap((suggestion) => suggestion.candidates) ??
    [];
  if (candidates.length === 0) return null;
  return (
    <RecordList aria-label="Transfer pair candidates" columns={PAIR_COLUMNS}>
      {candidates.map((candidate) => (
        <CandidateRow key={candidate.transactionId} candidate={candidate} />
      ))}
    </RecordList>
  );
}

/** The transfer reconciliation row's guided flow: pick the other leg. */
export function TransferPairAction({ action, target }: WorkActionProps) {
  const transactionId = target.scope === "item" ? target.row.id : null;
  if (!transactionId) return null;
  return (
    <WorkActionDialogTrigger action={action}>
      {(close) => (
        <Overlay
          open
          onOpenChange={(open) => !open && close()}
          title="Pair transfer"
          description="Accept the counterpart leg of this account transfer."
          size="lg"
          cancelLabel="Done"
        >
          <TransferPairAccept transactionId={transactionId} />
        </Overlay>
      )}
    </WorkActionDialogTrigger>
  );
}

const PAIR_COLUMNS = [
  { id: "amount", label: "Amount" },
  { id: "apart", label: "Apart" },
];

function partyName(party: Candidate["from"]) {
  return party?.name ?? "No owner";
}

function CandidateRow({ candidate }: { candidate: Candidate }) {
  const accept = useMutation(
    financialTransaction.acceptTransferPair.mutationOptions(),
  );
  // The error state below renders a thrown failure; a refusal is data.
  const onAccept = () =>
    accept.mutate({
      outflowTransactionId: candidate.outflowTransactionId,
      inflowTransactionId: candidate.inflowTransactionId,
    });
  const refusal =
    accept.data && !accept.data.canProceed ? accept.data.reason : null;
  const internal =
    candidate.from !== null &&
    candidate.to !== null &&
    candidate.from.id === candidate.to.id;
  return (
    <RecordRow
      primary={
        <EntityRefLink
          entity="financialTransaction"
          id={candidate.transactionId}
        />
      }
      secondary={`${partyName(candidate.from)} → ${partyName(candidate.to)}${internal ? " · internal move" : ""}`}
      facts={[
        {
          id: "amount",
          label: "Amount",
          value: formatCurrency(candidate.amount),
          className: "tabular-nums",
        },
        {
          id: "apart",
          label: "Apart",
          value: `${candidate.dateDistanceDays}d`,
          className: "tabular-nums",
        },
      ]}
      actions={
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="max-md:min-h-11"
          disabled={accept.isPending || accept.data?.canProceed === true}
          onClick={onAccept}
        >
          {accept.data?.canProceed ? "Accepted" : "Accept"}
        </Button>
      }
      detail={
        refusal || accept.isError ? (
          <>
            {refusal ? (
              <p role="alert" className="text-xs text-destructive">
                {refusal}
              </p>
            ) : null}
            {accept.isError ? (
              <p role="alert" className="text-xs text-destructive">
                {accept.error instanceof Error
                  ? accept.error.message
                  : String(accept.error)}
              </p>
            ) : null}
          </>
        ) : null
      }
    />
  );
}

import type { FinancialTransferPairSuggestionsOut } from "@cubby/schemas/household-contribution";
import { financialTransactionShortcode } from "@cubby/schemas/identifiers";
import { useMutation, useQuery } from "@tanstack/react-query";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  financialTransaction,
  householdContribution,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/number-format";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/common/ledger";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Button } from "~/ui/primitives/button";

type Candidate =
  FinancialTransferPairSuggestionsOut["suggestions"][number]["candidates"][number];

/** The Work queue key of an account transfer still missing transfer evidence. */
export const isTransferEvidenceRow = (row: {
  entity: string | null;
  key: string;
}) =>
  row.entity === "financialTransaction" &&
  row.key.startsWith("reconciliation:transfer");

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
    <Ledger aria-label="Transfer pair candidates">
      {candidates.map((candidate) => (
        <CandidateRow key={candidate.transactionId} candidate={candidate} />
      ))}
    </Ledger>
  );
}

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
    <LedgerRow>
      <LedgerCell
        as="div"
        slot="primary"
        className="flex flex-wrap items-center gap-1"
      >
        <EntityRefLink
          variant="byId"
          entityKind="financialTransaction"
          entityId={candidate.transactionId}
        />
        <span className="text-muted-foreground">
          {partyName(candidate.from)} → {partyName(candidate.to)}
          {internal ? " · internal move" : ""}
        </span>
      </LedgerCell>
      <LedgerCell
        as="div"
        slot="secondary"
        className="text-muted-foreground tabular-nums"
      >
        {formatCurrency(candidate.amount)} · {candidate.dateDistanceDays}d apart
        {refusal ? (
          <span role="alert" className="block text-destructive">
            {refusal}
          </span>
        ) : null}
        {accept.isError ? (
          <span role="alert" className="block text-destructive">
            {accept.error instanceof Error
              ? accept.error.message
              : String(accept.error)}
          </span>
        ) : null}
      </LedgerCell>
      <LedgerCell as="div" slot="trailing">
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
      </LedgerCell>
    </LedgerRow>
  );
}

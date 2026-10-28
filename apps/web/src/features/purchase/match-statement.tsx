import {
  financialTransactionShortcode,
  shortcode,
} from "@cubby/schemas/identifiers";
import type {
  PurchaseSettlementSuggestOut,
  SettlementAllocationDraft,
} from "@cubby/schemas/purchase";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { z } from "zod";

import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { financialTransaction as financeOperations } from "~/integrations/tanstack-query/domains/financialTransaction";
import { purchase as purchaseOperations } from "~/integrations/tanstack-query/domains/purchase";
import { formatCurrency } from "~/lib/number-format";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Input } from "~/ui/primitives/input";

import {
  SettlementCandidateList,
  type SettlementCandidate,
} from "./settlement-candidate-list";

type AllocationRow = SettlementAllocationDraft & { key: string };

/** A well-formed placeholder for the disabled check; never sent. */
const IDLE_TRANSACTION = shortcode("FTX-2222");

const settledDraft = z.object({
  transactionId: financialTransactionShortcode,
  allocations: z.array(
    z.object({ purchaseId: z.string(), amount: z.string() }),
  ),
});

const REFUSED = "These allocations cannot be saved.";

const withKeys = (
  rows: readonly SettlementAllocationDraft[],
): AllocationRow[] => rows.map((row) => ({ ...row, key: crypto.randomUUID() }));
const bare = ({
  purchaseId,
  amount,
}: AllocationRow): SettlementAllocationDraft => ({
  purchaseId,
  amount,
});

/**
 * Review unallocated charges and refunds near an order, and allocate one across Purchases. Which
 * entries are candidates, how they are worded, the rows an allocation starts from and whether the
 * typed rows can be saved are all the server's (`purchase.settlementCandidates`,
 * `purchase.checkSettlementAllocation`); the save is the transaction's own allocation update,
 * which validates again. Nothing is selected or saved on a suggestion's account.
 */
export function MatchStatementDialog({
  purchaseId,
  open,
  onOpenChange,
}: {
  purchaseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Each review visit owns its chosen transaction and editable allocation rows.
  // Reopening must not reuse either the prior draft or a pre-save candidate.
  return open ? (
    <MatchStatementReview purchaseId={purchaseId} onOpenChange={onOpenChange} />
  ) : null;
}

function MatchStatementReview({
  purchaseId,
  onOpenChange,
}: {
  purchaseId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [selected, setSelected] = useState<FinancialTransactionOut | null>(
    null,
  );
  const [rows, setRows] = useState<AllocationRow[]>([]);
  const queryClient = useQueryClient();
  const candidatesQuery = useQuery({
    ...purchaseOperations.settlementCandidates.queryOptions({ purchaseId }),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const review =
    candidatesQuery.fetchStatus === "idle" && candidatesQuery.isSuccess
      ? candidatesQuery.data
      : undefined;
  const update = useMutation(
    financeOperations.allocateSettlement.mutationOptions(),
  );
  // Advisory only: the result reorders and badges bounded candidates, and never
  // selects or allocates on the person's behalf.
  const suggest = useMutation(
    purchaseOperations.suggestSettlementMatch.mutationOptions(),
  );
  const suggestion: PurchaseSettlementSuggestOut | null = suggest.isError
    ? {
        status: "unavailable",
        error: String(suggest.error),
        note: `Suggestion unavailable: ${String(suggest.error)}`,
      }
    : (suggest.data ?? null);

  // Debounce one primitive key pairing the chosen entry with its rows, so the two change
  // together and an idle dialog never re-renders on a fresh array.
  const draftKey = JSON.stringify({
    transactionId: selected?.id ?? IDLE_TRANSACTION,
    allocations: rows.map(bare),
  });
  const [settledKey] = useDebouncedValue(draftKey, { wait: 250 });
  const settled = useMemo(
    () => settledDraft.parse(JSON.parse(settledKey)),
    [settledKey],
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  // `queryOptions` parses its input, so it needs a well-formed code even while no entry is
  // chosen; the query waits until the debounced draft is the chosen entry's.
  const check = useQuery({
    ...purchaseOperations.checkSettlementAllocation.queryOptions(settled),
    enabled: selected !== null && settled.transactionId === selected.id,
    placeholderData: keepPreviousData,
  });

  const note = saveError ?? check.data?.reason;
  const choose = (candidate: SettlementCandidate) => {
    setSelected(candidate.transaction);
    setRows(withKeys(candidate.proposedAllocations));
  };
  const edit = (index: number, patch: Partial<SettlementAllocationDraft>) =>
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );
  const saveAllocation = async () => {
    if (!selected) return;
    // Ask again with exactly what is typed now: the live check may lag a keystroke.
    const latest = await queryClient.fetchQuery({
      ...purchaseOperations.checkSettlementAllocation.queryOptions({
        transactionId: selected.id,
        allocations: rows.map(bare),
      }),
      staleTime: 0,
    });
    if (!latest.allocations) {
      setSaveError(latest.reason ?? REFUSED);
      return;
    }
    setSaveError(null);
    try {
      await update.mutateAsync({
        transactionId: selected.id,
        priorAllocations: selected.allocations,
        allocations: latest.allocations,
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return;
    }
    onOpenChange(false);
  };

  return (
    <Overlay
      open
      onOpenChange={onOpenChange}
      title="Match statement activity"
      description="Review unallocated charges and refunds near this order. Allocate the full statement amount across Purchases before saving."
      onCancel={() => onOpenChange(false)}
      error={note}
      primary={{
        label: "Save allocation",
        pending: update.isPending,
        disabled: !selected || !check.data?.allocations,
        onClick: saveAllocation,
      }}
    >
      {candidatesQuery.isPending || candidatesQuery.fetchStatus !== "idle" ? (
        <Description>
          {candidatesQuery.fetchStatus === "paused"
            ? "Waiting for a connection to check statement activity…"
            : "Checking statement activity…"}
        </Description>
      ) : null}
      {candidatesQuery.isError ? (
        <Description>{String(candidatesQuery.error)}</Description>
      ) : null}
      {review?.message ? <Description>{review.message}</Description> : null}
      {review ? (
        <SettlementCandidateList
          candidates={review.candidates}
          suggestHint={review.suggestHint}
          selectedId={selected?.id ?? null}
          suggestion={suggestion}
          suggesting={suggest.isPending}
          onSuggest={() => suggest.mutate({ purchaseId })}
          onSelect={choose}
        />
      ) : null}
      {selected ? (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="text-sm font-medium">
            Allocate {formatCurrency(selected.amount)}
          </div>
          {rows.map((row, index) => (
            <div key={row.key} className="grid grid-cols-[1fr_8rem] gap-2">
              <label
                htmlFor={`purchase-${row.key}`}
                className="space-y-1 text-xs text-muted-foreground"
              >
                Purchase code
                <Input
                  id={`purchase-${row.key}`}
                  aria-label={`Purchase code ${index + 1}`}
                  value={row.purchaseId}
                  onChange={(event) =>
                    edit(index, { purchaseId: event.target.value })
                  }
                />
              </label>
              <label
                htmlFor={`amount-${row.key}`}
                className="space-y-1 text-xs text-muted-foreground"
              >
                Amount
                <Input
                  id={`amount-${row.key}`}
                  aria-label={`Amount ${index + 1}`}
                  type="number"
                  step="0.01"
                  value={row.amount}
                  onChange={(event) =>
                    edit(index, { amount: event.target.value })
                  }
                />
              </label>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setRows((current) => [
                ...current,
                ...withKeys([{ purchaseId: "", amount: "" }]),
              ])
            }
          >
            Add Purchase
          </Button>
        </div>
      ) : null}
    </Overlay>
  );
}

/** The verb button and its review dialog. */
export function MatchStatementButton({
  purchaseId,
  label = "Match statement activity",
  disabledReason,
}: {
  purchaseId: string;
  label?: string;
  disabledReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabledReason != null}
        title={disabledReason ?? undefined}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <MatchStatementDialog
        purchaseId={purchaseId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

type FinancialTransactionOut = DetailRecordOf<"financialTransaction">;

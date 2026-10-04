import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import { financialTransactionShortcode } from "@cubby/schemas/identifiers";
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
import { useState } from "react";

import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { purchase as purchaseOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatCurrency } from "~/lib/utils";
import { useUpdateMutation } from "~/ui/hooks/useUpdateMutation";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { DialogFormActions } from "~/ui/primitives/dialog-form-actions";
import { Input } from "~/ui/primitives/input";

import {
  SettlementCandidateList,
  type SettlementCandidate,
} from "./settlement-candidate-list";

type AllocationRow = SettlementAllocationDraft & { key: string };

/** A well-formed placeholder for the disabled check; never sent. */
const IDLE_TRANSACTION = financialTransactionShortcode.parse("FTX-2222");

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
  const [selected, setSelected] = useState<FinancialTransactionOut | null>(
    null,
  );
  const [rows, setRows] = useState<AllocationRow[]>([]);
  const queryClient = useQueryClient();
  const candidatesQuery = useQuery({
    ...purchaseOperations.settlementCandidates.queryOptions({ purchaseId }),
    enabled: open,
  });
  const review = candidatesQuery.data;
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("financialTransaction", "update"),
    entity: "financialTransaction",
  });
  // Advisory only: the result reorders and badges tied candidates, and never
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

  const [typed] = useDebouncedValue(rows.map(bare), { wait: 250 });
  // `queryOptions` parses its input, so it needs a well-formed code even while no entry is
  // chosen; the query stays disabled until one is.
  const check = useQuery({
    ...purchaseOperations.checkSettlementAllocation.queryOptions({
      transactionId: selected?.id ?? IDLE_TRANSACTION,
      allocations: typed,
    }),
    enabled: selected !== null,
    placeholderData: keepPreviousData,
  });

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Match statement activity</DialogTitle>
          <DialogDescription>
            Review unallocated charges and refunds near this order. Allocate the
            full statement amount across Purchases before saving.
          </DialogDescription>
        </DialogHeader>
        {candidatesQuery.isPending ? (
          <Description>Checking statement activity…</Description>
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
            {check.data?.reason ? (
              <Description size="xs">{check.data.reason}</Description>
            ) : null}
          </div>
        ) : null}
        <DialogFormActions
          onCancel={() => onOpenChange(false)}
          submitLabel="Save allocation"
          pending={update.isPending}
          submitDisabled={!selected || !check.data?.allocations}
          onSubmit={async () => {
            if (!selected) return;
            // Ask again with exactly what is typed now: the live check may lag a keystroke.
            const latest = await queryClient.fetchQuery({
              ...purchaseOperations.checkSettlementAllocation.queryOptions({
                transactionId: selected.id,
                allocations: rows.map(bare),
              }),
              staleTime: 0,
            });
            if (!latest.allocations) return;
            await update.mutateAsync({
              id: selected.id,
              data: { allocations: latest.allocations },
            });
            // The global handler fires this ripple without awaiting it; await
            // it so the panel is fresh before the dialog closes.
            await invalidateOperationTags(
              queryClient,
              entityRipple("financialTransaction"),
            );
            onOpenChange(false);
            setSelected(null);
          }}
        />
      </DialogContent>
    </Dialog>
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

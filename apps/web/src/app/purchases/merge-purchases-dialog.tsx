import type { PreviewOperationInput } from "@cubby/schemas/entity-integrity";
import type { PurchaseId } from "@cubby/schemas/identifiers";
import type { PurchaseOut } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  OperationImpact,
  useOperationPreview,
} from "~/app/_components/impact/operation-impact";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseLabel } from "~/lib/purchase-label";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { useActionMutation } from "../_components/hooks/useActionMutation";

const NO_CANDIDATES: PurchaseOut[] = [];

/** Generous relative to any one vendor's charge count, within MAX_PAGE_SIZE. */
const CANDIDATE_PAGE_SIZE = 200;

/**
 * Fold other charges of the SAME vendor into this one.
 *
 * For the charges the backfill couldn't group — the singletons with no order id,
 * which no key could have joined without falsely merging unrelated transactions.
 *
 * The picker is scoped to one vendor because the mutation refuses to cross
 * vendors; beyond that scoping, nothing is pre-validated here. `mergePurchases`
 * also refuses when both sides carry a non-null order id (two real, distinct
 * orders), and that refusal surfaces as this dialog's error toast rather than as
 * a rule duplicated — and eventually drifting — in the UI.
 *
 * Not built on the shared `MergeConfirmation`: that component is
 * ingredient-specific (it fetches `entityIntegrity.previewOperation` for its keeper
 * ranking), and there is no purchase-side impact preview to rank by — the keeper
 * is fixed here, it's the charge you're looking at.
 */
export function MergePurchasesDialog({
  open,
  onOpenChange,
  purchase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchase: PurchaseOut;
}) {
  const api = useTRPC();
  const [selected, setSelected] = useState<PurchaseId[]>([]);

  const candidatesQuery = useQuery({
    ...api.purchase.list.queryOptions({
      filters: { vendorId: purchase.vendorId },
      pagination: { pageIndex: 0, pageSize: CANDIDATE_PAGE_SIZE },
    }),
    enabled: open,
  });

  const candidates = useMemo(
    () =>
      candidatesQuery.data?.items.filter((row) => row.id !== purchase.id) ??
      NO_CANDIDATES,
    [candidatesQuery.data, purchase.id],
  );

  const mergeMutation = useActionMutation({
    mutationFn: api.purchase.merge.mutationOptions,
    success: "Charges merged",
    invalidateKeys: purchaseMutationInvalidateKeys,
    onSuccess: () => {
      setSelected([]);
      onOpenChange(false);
    },
  });

  const toggle = (id: PurchaseId) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
    );

  // Impact preview — fetched only while the dialog is open, always fresh for
  // the current selection. Purchase merge has real server-enforced blockers
  // (cross-vendor, both-sides-have-orderId) that would otherwise only surface
  // as an error toast after the fact, so this one DOES gate confirmation on
  // `canProceed === false` — see `useOperationPreview`'s doc comment.
  const previewInput = useMemo<PreviewOperationInput | null>(
    () =>
      selected.length > 0
        ? {
            operation: "merge",
            entity: "purchase",
            keepId: purchase.id,
            mergeIds: selected,
          }
        : null,
    [purchase.id, selected],
  );
  const preview = useOperationPreview(previewInput, open);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSelected([]);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge into {purchaseLabel(purchase)}</DialogTitle>
          <DialogDescription>
            Pick other {purchase.vendorName ?? "vendor"} charges to fold in.
            Their lines and documents move onto this charge; the folded charges
            are then deleted.
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <Empty variant="minimal" className="py-6">
            <EmptyTitle>Nothing to merge</EmptyTitle>
            <EmptyDescription>
              {purchase.vendorName ?? "This vendor"} has no other charges on
              file.
            </EmptyDescription>
          </Empty>
        ) : (
          <Stack gap="xs" className="max-h-64 overflow-y-auto">
            {candidates.map((candidate) => (
              <Row
                key={candidate.id}
                align="center"
                gap="sm"
                className="min-w-0 border border-[var(--border)] px-2 py-1"
              >
                <Checkbox
                  checked={selected.includes(candidate.id)}
                  onCheckedChange={() => toggle(candidate.id)}
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {purchaseLabel(candidate)}
                </span>
                <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
                  {candidate.expenseCount} ·{" "}
                  {formatCurrency(candidate.expenseTotal)}
                </span>
              </Row>
            ))}
          </Stack>
        )}

        <Description size="xs">
          One purchase is one vendor transaction, never a contract — a payment
          schedule stays as separate charges. Merge only rows that are genuinely
          the same transaction.
        </Description>

        {selected.length > 0 && (
          <OperationImpact
            preview={preview.data}
            isLoading={preview.isLoading}
            isError={preview.isError}
            onRetry={() => void preview.refetch()}
          />
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              selected.length === 0 ||
              mergeMutation.isPending ||
              preview.data?.canProceed === false
            }
            onClick={() =>
              mergeMutation.mutate({
                keepId: purchase.id,
                mergeIds: selected,
              })
            }
          >
            {mergeMutation.isPending
              ? "Merging..."
              : `Merge ${selected.length || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

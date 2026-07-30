import type { DuplicateVendor } from "@cubby/schemas/problems";
import { useProblemCardMutation } from "~/app/_components/hooks/useProblemCardMutation";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import {
  productMutationInvalidateKeys,
  purchaseMutationInvalidateKeys,
} from "~/lib/query-keys";

/**
 * Small inline fixes for problems whose resolution is a single field or a
 * delete — no rich editor needed. Each owns its own mutation hook (mounted only
 * while the card is expanded) and clears its problem on success.
 */

/**
 * Delete an orphaned product. findOrphanedProducts and deleteProducts' safety
 * checks agree on the same two acquisition edges (inventory, expenses), so a
 * product surfaced here can't trip either guard.
 */
export function OrphanedDeleteFix({
  id,
  name,
  close,
}: {
  id: string;
  name: string;
  close: () => void;
}) {
  const api = useTRPC();
  const remove = useProblemCardMutation({
    mutationFn: api.product.delete.mutationOptions,
    success: "Product deleted",
    invalidateKeys: productMutationInvalidateKeys,
    onSuccess: close,
  });

  return (
    <Stack gap="sm">
      <p className="text-muted-foreground text-xs">
        Delete <span className="font-medium">{name}</span>? It has no inventory,
        no expenses, and isn't linked to an ingredient.
      </p>
      <Button
        size="sm"
        variant="destructive"
        onClick={() => remove.mutate({ ids: [id] })}
        disabled={remove.isPending}
      >
        Delete product
      </Button>
    </Stack>
  );
}

/** `1 charge` / `4 charges` — a vendor's weight in the merge decision. */
const charges = (n: number) => `${n} charge${n === 1 ? "" : "s"}`;

/**
 * Fold a duplicate vendor into the spelling that carries more charges.
 *
 * The one Problems fix that RETIRES an entity rather than editing a field, so it
 * spells out both sides and which one survives before offering the button —
 * `mergeVendors` soft-deletes the loser, and there is no restore.
 *
 * All of the actual work belongs to `mergeVendors` (repo/vendor.ts): it carries
 * `website`/`notes` over only when the keeper lacks them, and folds any charges
 * the two vendors hold under the same order id, which the partial-unique
 * `(vendorId, orderId)` index would otherwise reject. Nothing here re-derives any
 * of that; it passes two ids.
 *
 * Invalidates the PURCHASE key set, not just the vendor one: folding a charge
 * re-parents its expenses, so the expense/project/dashboard rollups go stale too
 * — the same reason `purchaseMutationInvalidateKeys` is a superset of
 * `vendorMutationInvalidateKeys`.
 */
export function DuplicateVendorMergeFix({
  variant,
  close,
}: {
  variant: DuplicateVendor;
  close: () => void;
}) {
  const api = useTRPC();
  const merge = useProblemCardMutation({
    mutationFn: api.vendor.merge.mutationOptions,
    success: (vendor) => `Merged into ${vendor.name}`,
    invalidateKeys: purchaseMutationInvalidateKeys,
    onSuccess: close,
  });

  return (
    <Stack gap="sm">
      <p className="text-muted-foreground text-xs">
        Merge <span className="font-medium">{variant.value}</span> (
        {charges(variant.count)}) into{" "}
        <span className="font-medium">{variant.canonical}</span> (
        {charges(variant.canonicalCount)})? Every charge moves to{" "}
        {variant.canonical} and {variant.value} leaves the roster. Its website
        and notes carry over only where {variant.canonical} has none.
      </p>
      <Button
        size="sm"
        onClick={() =>
          merge.mutate({
            keepId: variant.canonicalSampleId,
            mergeIds: [variant.sampleId],
          })
        }
        disabled={merge.isPending}
      >
        {merge.isPending ? "Merging…" : `Merge into ${variant.canonical}`}
      </Button>
    </Stack>
  );
}

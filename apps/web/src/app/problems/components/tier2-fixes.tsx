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
 * checks agree on the same two acquisition edges (inventory, purchases), so a
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
        no purchases, and isn't linked to an ingredient.
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

/**
 * Backfill the missing vendor on an order whose rows disagree about it.
 *
 * Sends only the order id — the server re-derives the vendor from the order's
 * own rows, so this can't write a stale value, and re-running it after it's
 * applied resolves to nothing rather than writing again. Only rendered when the
 * order's populated rows agree on exactly one vendor; two distinct vendors is a
 * real collision the card reports without offering a fix.
 */
export function OrderVendorBackfillFix({
  orderId,
  vendor,
  missingCount,
  close,
}: {
  orderId: string;
  vendor: string;
  missingCount: number;
  close: () => void;
}) {
  const api = useTRPC();
  const backfill = useProblemCardMutation({
    mutationFn: api.problems.backfillOrderVendor.mutationOptions,
    // Reports what actually happened, including the no-op: the server re-derives
    // the vendor, so a card left open while the order was fixed elsewhere
    // resolves to nothing rather than silently claiming a write.
    success: (data) =>
      data.vendor
        ? `Vendor set on ${data.updated} row${data.updated === 1 ? "" : "s"}`
        : "Order already consistent",
    invalidateKeys: purchaseMutationInvalidateKeys,
    onSuccess: close,
  });

  return (
    <Stack gap="sm">
      <p className="text-muted-foreground text-xs">
        Set vendor <span className="font-medium">{vendor}</span> on{" "}
        {missingCount} row{missingCount === 1 ? "" : "s"} of order{" "}
        <span className="font-mono">{orderId}</span>? Until then the order reads
        as two separate groups.
      </p>
      <Button
        size="sm"
        onClick={() => backfill.mutate({ orderId })}
        disabled={backfill.isPending}
      >
        Backfill vendor
      </Button>
    </Stack>
  );
}

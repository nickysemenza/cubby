import { useProblemCardMutation } from "~/app/_components/hooks/useProblemCardMutation";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import { productMutationInvalidateKeys } from "~/lib/query-keys";

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

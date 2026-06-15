import { useState } from "react";
import { toast } from "sonner";
import { useProblemCardMutation } from "~/app/_components/hooks/useProblemCardMutation";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

/**
 * Small inline fixes for problems whose resolution is a single field or a
 * delete — no rich editor needed. Each owns its own mutation hook (mounted only
 * while the card is expanded) and clears its problem on success.
 */

/** Fix a zero/negative inventory amount: set a positive value, or delete the entry. */
export function InventoryAmountFix({
  id,
  unit,
  close,
}: {
  id: string;
  unit: string;
  close: () => void;
}) {
  const api = useTRPC();
  const [value, setValue] = useState("");
  const update = useProblemCardMutation({
    mutationFn: api.inventory.update.mutationOptions,
    success: "Amount updated",
    invalidateKeys: [queryKeys.inventory.list],
    onSuccess: close,
  });
  const remove = useProblemCardMutation({
    mutationFn: api.inventory.delete.mutationOptions,
    success: "Inventory entry deleted",
    invalidateKeys: [queryKeys.inventory.list],
    onSuccess: close,
  });
  const busy = update.isPending || remove.isPending;

  const save = () => {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Enter an amount greater than 0");
      return;
    }
    update.mutate({ id, data: { amount: { value: n, unit } } });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <Input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          placeholder="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-24"
        />
        <span>{unit}</span>
        <Button size="sm" onClick={save} disabled={busy}>
          Save
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => remove.mutate({ ids: [id] })}
          disabled={busy}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

/** Fix an invalid/duplicate UPC: edit it, or clear it entirely. */
export function ProductUpcFix({
  id,
  upc,
  close,
}: {
  id: string;
  upc: string;
  close: () => void;
}) {
  const api = useTRPC();
  const [next, setNext] = useState(upc);
  const update = useProblemCardMutation({
    mutationFn: api.product.update.mutationOptions,
    success: "UPC updated",
    invalidateKeys: [queryKeys.product.list],
    onSuccess: close,
  });

  const save = (upcValue: string | null) =>
    update.mutate({ id, data: { upc: upcValue } });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <Input
          inputMode="numeric"
          placeholder="UPC"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="w-40 font-mono"
        />
        <Button
          size="sm"
          onClick={() => save(next.trim() || null)}
          disabled={update.isPending}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => save(null)}
          disabled={update.isPending}
        >
          Clear UPC
        </Button>
      </div>
    </div>
  );
}

/** Delete an orphaned product (no inventory, so the safety check can't trip). */
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
    invalidateKeys: [queryKeys.product.list],
    onSuccess: close,
  });

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        Delete <span className="font-medium">{name}</span>? It has no inventory
        and isn't linked to a recipe.
      </p>
      <Button
        size="sm"
        variant="destructive"
        onClick={() => remove.mutate({ ids: [id] })}
        disabled={remove.isPending}
      >
        Delete product
      </Button>
    </div>
  );
}

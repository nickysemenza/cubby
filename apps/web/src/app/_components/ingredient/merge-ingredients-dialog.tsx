import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "sonner";
import { MergeConfirmation } from "~/app/_components/ingredient/merge-confirmation";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

export type MergeCandidate = { id: string; name: string };

/**
 * Standalone merge dialog wrapping the shared {@link MergeConfirmation} body
 * with its own `ingredient.merge` mutation. Used by the ingredient-usage
 * table's "merge?" affordance (the bulk-action list path drives the same
 * presentational body via its own dialog framework).
 */
export function MergeIngredientsDialog({
  open,
  onOpenChange,
  ingredients,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ingredients: MergeCandidate[];
  onMerged?: () => void;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  // Mirror of MergeConfirmation's chosen target; defaults to the first (= the
  // most-used member, since callers pass rows already sorted by usage).
  const targetRef = useRef<string | null>(ingredients[0]?.id ?? null);

  const mergeMutation = useMutation(
    api.ingredient.merge.mutationOptions({
      onSuccess: (_data, variables) => {
        const target = ingredients.find((i) => i.id === variables.target);
        toast.success(
          `Merged into ${target?.name ?? "ingredient"} (${variables.aliases.length} folded in)`,
        );
        void queryClient.invalidateQueries({
          queryKey: [queryKeys.ingredient.list],
        });
        void queryClient.invalidateQueries({
          queryKey: [queryKeys.recipe.ingredientUsage],
        });
        onMerged?.();
        onOpenChange(false);
      },
      onError: (err) => toast.error(getErrorMessage(err)),
    }),
  );

  const handleMerge = () => {
    const chosen = targetRef.current;
    const targetId =
      chosen && ingredients.some((i) => i.id === chosen)
        ? chosen
        : ingredients[0]?.id;
    const target = ingredients.find((i) => i.id === targetId);
    if (!target) return;
    const aliases = ingredients
      .filter((i) => i.id !== target.id)
      .map((a) => a.id);
    if (aliases.length === 0) return;
    mergeMutation.mutate({ target: target.id, aliases });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge ingredients</DialogTitle>
          <DialogDescription>
            These look like the same ingredient. Pick the one to keep — the
            others fold into it as aliases.
          </DialogDescription>
        </DialogHeader>
        <MergeConfirmation ingredients={ingredients} targetRef={targetRef} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleMerge}
            disabled={mergeMutation.isPending || ingredients.length < 2}
          >
            {mergeMutation.isPending ? "Merging…" : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { TrashIcon as Trash2 } from "@phosphor-icons/react/dist/csr/Trash";
import { type ReactNode, useState } from "react";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Stack } from "~/components/layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { countLabel } from "~/lib/pluralize";
import { problems } from "~/lib/problems.functions";

/**
 * Per-card and bulk cleanup actions for the three ingredient problem sections.
 * Per-card fixes own a mutation hook (mounted only while the card is expanded)
 * and clear their card on success; the bulk buttons confirm first, then act on
 * every rendered row at once. All invalidate the problems path so the page's
 * cost-grouped queries and the badge's combined scan both re-read.
 */

export function UnusedIngredientDeleteFix({
  id,
  name,
  alsoDeleteProducts,
  close,
}: {
  id: string;
  name: string;
  alsoDeleteProducts: boolean;
  close: () => void;
}) {
  const noun = alsoDeleteProducts ? "Ingredient and product(s)" : "Ingredient";
  const remove = useActionMutation({
    mutationFn: problems.deleteUnused.mutationOptions,
    // The endpoint reports per-ingredient failures (e.g. a product still has
    // inventory) instead of throwing, so the toast text reflects the outcome.
    success: (data) =>
      data.deleted > 0
        ? `${noun} deleted`
        : `Could not delete: ${data.failed[0]?.reason ?? "unknown error"}`,
    onSuccess: (data) => {
      if (data.deleted > 0) close();
    },
  });

  return (
    <Stack gap="sm">
      <p className="text-xs text-muted-foreground">
        Delete <span className="font-medium">{name}</span>?{" "}
        {alsoDeleteProducts
          ? "Its linked product(s) are deleted too."
          : "It isn't used in any recipe."}
      </p>
      <Button
        size="sm"
        variant="destructive"
        onClick={() =>
          remove.mutate({ ingredientIds: [id], alsoDeleteProducts })
        }
        disabled={remove.isPending}
      >
        {alsoDeleteProducts ? "Delete ingredient + product(s)" : "Delete"}
      </Button>
    </Stack>
  );
}

// ── Bulk header buttons ──────────────────────────────────────────────────────

/** A destructive header button that confirms before running its action. */
function ConfirmHeaderButton({
  label,
  title,
  body,
  onConfirm,
  isPending,
}: {
  label: string;
  title: string;
  body: ReactNode;
  onConfirm: () => void;
  isPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="destructive"
        onClick={() => setOpen(true)}
        disabled={isPending}
      >
        <Trash2 className="mr-1 size-3" />
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onConfirm();
                setOpen(false);
              }}
            >
              {label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Bulk "Delete all" for both unused-ingredient sections. */
/**
 * "Delete every unused ingredient in this section."
 *
 * Takes a COUNT and a section key, never the rendered rows: the section shows a
 * page of the view's results, so acting on what it rendered would delete twelve
 * and call it all. The server re-runs the view's own filters to resolve the set.
 */
export function DeleteAllUnusedButton({
  count,
  problemKey,
  alsoDeleteProducts,
}: {
  count: number;
  problemKey:
    | "unusedIngredientsWithProduct"
    | "unusedIngredientsWithoutProduct";
  alsoDeleteProducts: boolean;
}) {
  const remove = useActionMutation({
    mutationFn: problems.deleteUnused.mutationOptions,
    success: (data) =>
      data.failed.length > 0
        ? `Deleted ${data.deleted}, ${data.failed.length} failed (e.g. ${data.failed[0]?.reason ?? "unknown"})`
        : `Deleted ${countLabel(data.deleted, "ingredient")}`,
  });

  return (
    <ConfirmHeaderButton
      label={`Delete all (${count})`}
      title="Delete all unused ingredients?"
      body={
        alsoDeleteProducts
          ? `This deletes ${countLabel(count, "ingredient")} and their linked products. Any whose product still has inventory will be skipped.`
          : `This deletes ${countLabel(count, "ingredient")}.`
      }
      isPending={remove.isPending}
      onConfirm={() =>
        remove.mutate({ allFromProblem: problemKey, alsoDeleteProducts })
      }
    />
  );
}

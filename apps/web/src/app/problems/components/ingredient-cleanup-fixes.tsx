import { Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useProblemCardMutation } from "~/app/_components/hooks/useProblemCardMutation";
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
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

/**
 * Per-card and bulk cleanup actions for the three ingredient problem sections.
 * Per-card fixes own a mutation hook (mounted only while the card is expanded)
 * and clear their card on success; the bulk buttons confirm first, then act on
 * every rendered row at once. All invalidate the whole `problems.*` path
 * (queryKeys.problems.all) so the page's cost-grouped queries and the badge's
 * combined scan both re-read.
 */

// ── Per-card fixes ───────────────────────────────────────────────────────────

/** Strip the listed unused aliases from one ingredient (leaves the ingredient). */
export function AliasPruneFix({
  id,
  name,
  unusedAliases,
  close,
}: {
  id: string;
  name: string;
  unusedAliases: string[];
  close: () => void;
}) {
  const api = useTRPC();
  const prune = useProblemCardMutation({
    mutationFn: api.problems.pruneAliases.mutationOptions,
    success: `Removed ${countLabel(unusedAliases.length, "alias", "aliases")} from ${name}`,
    invalidateKeys: [queryKeys.ingredient.list],
    onSuccess: close,
  });

  return (
    <Stack gap="sm">
      <p className="text-muted-foreground text-xs">
        Remove <span className="font-medium">{unusedAliases.join(", ")}</span>{" "}
        from <span className="font-medium">{name}</span>? The ingredient itself
        stays.
      </p>
      <Button
        size="sm"
        variant="destructive"
        onClick={() =>
          prune.mutate({ items: [{ ingredientId: id, remove: unusedAliases }] })
        }
        disabled={prune.isPending}
      >
        Remove {countLabel(unusedAliases.length, "alias", "aliases")}
      </Button>
    </Stack>
  );
}

/** Delete one unused ingredient (and, when `alsoDeleteProducts`, its products). */
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
  const api = useTRPC();
  const noun = alsoDeleteProducts ? "Ingredient and product(s)" : "Ingredient";
  const remove = useProblemCardMutation({
    mutationFn: api.problems.deleteUnused.mutationOptions,
    // The endpoint reports per-ingredient failures (e.g. a product still has
    // inventory) instead of throwing, so the toast text reflects the outcome.
    success: (data) =>
      data.deleted > 0
        ? `${noun} deleted`
        : `Could not delete: ${data.failed[0]?.reason ?? "unknown error"}`,
    invalidateKeys: [
      queryKeys.ingredient.list,
      ...(alsoDeleteProducts ? [queryKeys.product.all] : []),
    ],
    onSuccess: (data) => {
      if (data.deleted > 0) close();
    },
  });

  return (
    <Stack gap="sm">
      <p className="text-muted-foreground text-xs">
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
        <Trash2 className="mr-1 h-3 w-3" />
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

/** Bulk "Remove all" for the unused-aliases section. */
export function RemoveAllAliasesButton({
  rows,
}: {
  rows: { id: string; unusedAliases: string[] }[];
}) {
  const api = useTRPC();
  const total = rows.reduce((n, r) => n + r.unusedAliases.length, 0);
  const prune = useActionMutation({
    mutationFn: api.problems.pruneAliases.mutationOptions,
    success: (data) => `Removed ${countLabel(data.pruned, "alias", "aliases")}`,
    invalidateKeys: [queryKeys.problems.all, queryKeys.ingredient.list],
  });

  return (
    <ConfirmHeaderButton
      label={`Remove all (${total})`}
      title="Remove all unused aliases?"
      body={`This strips ${countLabel(total, "alias", "aliases")} across ${countLabel(rows.length, "ingredient")}. The ingredients themselves stay.`}
      isPending={prune.isPending}
      onConfirm={() =>
        prune.mutate({
          items: rows.map((r) => ({
            ingredientId: r.id,
            remove: r.unusedAliases,
          })),
        })
      }
    />
  );
}

/** Bulk "Delete all" for both unused-ingredient sections. */
export function DeleteAllUnusedButton({
  ids,
  alsoDeleteProducts,
}: {
  ids: string[];
  alsoDeleteProducts: boolean;
}) {
  const api = useTRPC();
  const remove = useActionMutation({
    mutationFn: api.problems.deleteUnused.mutationOptions,
    success: (data) =>
      data.failed.length > 0
        ? `Deleted ${data.deleted}, ${data.failed.length} failed (e.g. ${data.failed[0]?.reason ?? "unknown"})`
        : `Deleted ${countLabel(data.deleted, "ingredient")}`,
    invalidateKeys: [
      queryKeys.problems.all,
      queryKeys.ingredient.list,
      ...(alsoDeleteProducts ? [queryKeys.product.all] : []),
    ],
  });

  return (
    <ConfirmHeaderButton
      label={`Delete all (${ids.length})`}
      title="Delete all unused ingredients?"
      body={
        alsoDeleteProducts
          ? `This deletes ${countLabel(ids.length, "ingredient")} and their linked products. Any whose product still has inventory will be skipped.`
          : `This deletes ${countLabel(ids.length, "ingredient")}.`
      }
      isPending={remove.isPending}
      onConfirm={() =>
        remove.mutate({ ingredientIds: ids, alsoDeleteProducts })
      }
    />
  );
}

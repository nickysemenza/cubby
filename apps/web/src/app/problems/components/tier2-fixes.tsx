import { ProblemItem } from "@cubby/schemas/problems";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { EntityMergeDialog } from "~/app/_components/merge/entity-merge-dialog";
import { product } from "~/app/products/product.functions";
import { vendor } from "~/app/vendors/vendor.functions";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";

const deleteProduct = entityMutationOptionsFactory("product", "delete");

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
  const remove = useActionMutation({
    mutationFn: deleteProduct,
    success: "Product deleted",
    onSuccess: close,
  });

  return (
    <Stack gap="sm">
      <p className="text-xs text-muted-foreground">
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

/** `1 purchase` / `4 purchases` — a vendor's weight in the merge decision. */
const purchases = (n: number) => `${n} purchase${n === 1 ? "" : "s"}`;

/**
 * Fold a duplicate vendor into the spelling that carries more purchases.
 *
 * The one Problems fix that RETIRES an entity rather than editing a field, so it
 * spells out both sides and which one survives before offering the button —
 * `mergeVendors` soft-deletes the loser, and there is no restore.
 *
 * All of the actual work belongs to `mergeVendors` (repo/vendor.ts): it carries
 * `website`/`notes` over only when the keeper lacks them, and folds any purchases
 * the two vendors hold under the same order id, which the partial-unique
 * `(vendorId, orderId)` index would otherwise reject. Nothing here re-derives any
 * of that; it passes two ids.
 *
 * `vendor.merge` ripples as a PURCHASE write, not a vendor one: folding a
 * purchase re-parents its expenses, so the expense/project/dashboard rollups go
 * stale too. See `ripple.vendorMerge`.
 */
export function DuplicateVendorMergeFix({
  variant,
  close,
}: {
  variant: ProblemItem<"duplicateVendors">;
  close: () => void;
}) {
  const merge = useActionMutation({
    mutationFn: vendor.merge.mutationOptions,
    // Now that the merge reports what it moved, say so: "Merged into Amazon"
    // gave no way to tell a no-op merge from one that repointed 40 purchases.
    success: ({ vendor, mergeSummary }) => {
      const moved =
        mergeSummary.purchasesRepointed + mergeSummary.purchasesFolded;
      return moved === 0
        ? `Merged into ${vendor.name}`
        : `Merged into ${vendor.name} — ${moved} purchase(s) moved`;
    },
    onSuccess: close,
  });

  return (
    <Stack gap="sm">
      <p className="text-xs text-muted-foreground">
        Merge <span className="font-medium">{variant.value}</span> (
        {purchases(variant.count)}) into{" "}
        <span className="font-medium">{variant.canonical}</span> (
        {purchases(variant.canonicalCount)})? Every purchase moves to{" "}
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

/**
 * Fold a cluster of duplicate product rows (same maker part number, split
 * across retailers) into one, via the shared {@link EntityMergeDialog} —
 * `entities.tsx`'s `product.mergeable` config (keeperMode "ranked") supplies
 * the picker copy and row rendering. Unlike {@link DuplicateVendorMergeFix},
 * the detector (`findDuplicateProductIdentities`) has no canonical row to
 * default to — every member is an equally plausible keeper — so ranked mode's
 * toggle-button picker (defaulting to the first row) fits, same as ingredient.
 *
 * The card's `close` doubles as the dialog's dismiss: this component only
 * mounts while the problem/recommendation card is expanded, so there is no
 * separate open state to track — Cancel or a successful merge both collapse
 * the card the same way.
 *
 * `product.merge` carries `ripple.productMerge`, not the plain product one —
 * for the same reason {@link DuplicateVendorMergeFix} reaches past the vendor
 * set. A merge re-parents inventory, expenses, and projectUses and recomputes
 * dependent recipe costs, none of which an ordinary product write touches.
 */
export function DuplicateProductMergeFix({
  variant,
  close,
}: {
  variant: ProblemItem<"duplicateProductIdentities">;
  close: () => void;
}) {
  const merge = useActionMutation({
    mutationFn: product.merge.mutationOptions,
    success: (result) => `Merged into ${result.product.name}`,
    onSuccess: close,
  });

  return (
    <EntityMergeDialog
      entity="product"
      rows={variant.products}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onConfirm={(keepId, mergeIds) => merge.mutate({ keepId, mergeIds })}
      isPending={merge.isPending}
    />
  );
}

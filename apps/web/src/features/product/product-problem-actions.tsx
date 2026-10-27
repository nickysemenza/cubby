import { ProblemItem } from "@cubby/schemas/problems";

import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { EntityMergeDialog } from "~/entity/merge/entity-merge-dialog";
import type { WorkActionProps } from "~/entity/work-queue/work-actions";
import { WorkActionTrigger } from "~/entity/work-queue/work-actions";
import { useBackfill } from "~/features/maintenance/backfill-button";
import { BACKFILL } from "~/features/maintenance/backfill-registry";
import { ProblemItemsAction } from "~/features/work-queue/problem-items-action";
import { recommendations } from "~/integrations/tanstack-query/generated/catalog/recommendations.gen";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

const deleteProduct = entityMutationOptionsFactory("product", "delete");

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
 * A product merge carries `ripple.productMerge`, not the plain product one —
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
  const mutation = useActionMutation({
    mutationFn: () => recommendations.mergeProductMatch.mutationOptions(),
    success: "Merged Product identity",
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
      onConfirm={(keepId, mergeIds) => {
        const mergeId = mergeIds[0];
        const pair = variant.pairs.find(
          (candidate) =>
            candidate.productIds.some((id) => id === keepId) &&
            mergeId &&
            candidate.productIds.some((id) => id === mergeId),
        );
        if (
          mergeIds.length !== 1 ||
          !mergeId ||
          !pair?.fingerprint ||
          pair.identityConflict
        )
          throw new Error(
            "Choose one independently assessed pair with current identity evidence",
          );
        mutation.mutate({
          keepId,
          mergeId,
          assessmentId: pair.assessmentId,
          expectedFingerprint: pair.fingerprint,
        });
      }}
      isPending={mutation.isPending}
    />
  );
}

/** `orphanedProducts:delete`: each orphan the detector lists, with Delete. */
export function OrphanedProductDeleteAction(props: WorkActionProps) {
  return (
    <ProblemItemsAction {...props} problemKey="orphanedProducts">
      {(item, close) => (
        <OrphanedDeleteFix id={item.id} name={item.name} close={close} />
      )}
    </ProblemItemsAction>
  );
}

/** `duplicateProductIdentities:merge`: each duplicate cluster's merge. */
export function DuplicateProductMergeAction(props: WorkActionProps) {
  return (
    <ProblemItemsAction {...props} problemKey="duplicateProductIdentities">
      {(variant, close) => (
        <DuplicateProductMergeFix variant={variant} close={close} />
      )}
    </ProblemItemsAction>
  );
}

/** `productsWithNoImages:fetch-images`: the UPC image backfill. */
export function FetchProductImagesAction(props: WorkActionProps) {
  const backfill = useBackfill(BACKFILL.fetchUpcImages);
  return (
    <WorkActionTrigger
      {...props}
      pending={backfill.running}
      onRun={backfill.start}
    />
  );
}

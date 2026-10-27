import { ProblemItem } from "@cubby/schemas/problems";
import { countLabel } from "@cubby/shared/pluralize";

import {
  productionLogoOperations,
  useFetchVendorLogo,
} from "~/entity/actions/vendor-logo-entity-action";
import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import {
  WorkActionTrigger,
  type WorkActionProps,
} from "~/entity/work-queue/work-actions";
import { ProblemItemsAction } from "~/features/work-queue/problem-items-action";
import { vendor } from "~/integrations/tanstack-query/generated/catalog/vendor.gen";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

/** `1 purchase` / `4 purchases` — a vendor's weight in the merge decision. */
const purchases = (n: number) => countLabel(n, "purchase");

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

/** `duplicateVendors:merge`: each duplicate spelling's merge. */
export function DuplicateVendorMergeAction(props: WorkActionProps) {
  return (
    <ProblemItemsAction {...props} problemKey="duplicateVendors">
      {(variant, close) => (
        <DuplicateVendorMergeFix variant={variant} close={close} />
      )}
    </ProblemItemsAction>
  );
}

/** `vendorsWithoutLogos:fetch-logo`: fetch the row's Vendor logo. */
export function VendorLogoFetchWorkAction(props: WorkActionProps) {
  const fetchLogo = useFetchVendorLogo(productionLogoOperations);
  const id = props.target.scope === "item" ? props.target.row.id : null;
  if (!id) return null;
  return (
    <WorkActionTrigger
      {...props}
      pending={fetchLogo.isPending(id)}
      onRun={() => {
        void fetchLogo.fetch(id).catch(() => {
          // SILENT: useFetchVendorLogo already displays the raw mutation error.
        });
      }}
    />
  );
}

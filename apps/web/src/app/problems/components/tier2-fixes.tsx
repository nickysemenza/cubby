import type {
  DuplicateProductIdentity,
  DuplicateVendor,
} from "@cubby/schemas/problems";
import { Check } from "lucide-react";
import { useMemo, useState } from "react";
import { useProblemCardMutation } from "~/app/_components/hooks/useProblemCardMutation";
import {
  OperationImpact,
  type PreviewOperationDraft,
  useOperationPreview,
} from "~/app/_components/impact/operation-impact";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import {
  productMergeMutationInvalidateKeys,
  productMutationInvalidateKeys,
  purchaseMutationInvalidateKeys,
} from "~/lib/query-keys";
import { cn } from "~/lib/utils";

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
 * Invalidates the PURCHASE key set, not just the vendor one: folding a purchase
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

  // Impact preview — this card only exists while expanded, so there's no
  // separate "open" state to gate on; fetch as soon as it mounts. See
  // `useOperationPreview`'s doc comment for the gating rule.
  const previewInput = useMemo<PreviewOperationDraft>(
    () => ({
      operation: "merge",
      entity: "vendor",
      keepId: variant.canonicalSampleId,
      mergeIds: [variant.sampleId],
    }),
    [variant.canonicalSampleId, variant.sampleId],
  );
  const preview = useOperationPreview(previewInput, true);

  return (
    <Stack gap="sm">
      <p className="text-muted-foreground text-xs">
        Merge <span className="font-medium">{variant.value}</span> (
        {purchases(variant.count)}) into{" "}
        <span className="font-medium">{variant.canonical}</span> (
        {purchases(variant.canonicalCount)})? Every purchase moves to{" "}
        {variant.canonical} and {variant.value} leaves the roster. Its website
        and notes carry over only where {variant.canonical} has none.
      </p>
      <OperationImpact
        preview={preview.data}
        isLoading={preview.isLoading}
        isError={preview.isError}
        onRetry={() => void preview.refetch()}
      />
      <Button
        size="sm"
        onClick={() =>
          merge.mutate({
            keepId: variant.canonicalSampleId,
            mergeIds: [variant.sampleId],
          })
        }
        disabled={merge.isPending || preview.data?.canProceed === false}
      >
        {merge.isPending ? "Merging…" : `Merge into ${variant.canonical}`}
      </Button>
    </Stack>
  );
}

/**
 * Fold a cluster of duplicate product rows (same maker part number, split
 * across retailers) into one. Unlike {@link DuplicateVendorMergeFix}, the
 * detector (`findDuplicateProductIdentities`) has no canonical row to default
 * to — every member is an equally plausible keeper — so this renders a picker
 * (same toggle-button idiom as `IngredientMergeDialog`'s keeper picker) and
 * defaults to the first row.
 *
 * Product merge has a real merge-time blocker that vendor merge doesn't:
 * `PRODUCT_MERGE_INVENTORY_UNIT_MISMATCH` when the keeper and a loser both
 * hold inventory at the same location in incompatible units. The preview is
 * advisory (`useOperationPreview`'s doc comment) — it never gates on loading
 * or erroring — but a POSITIVELY returned `canProceed: false` (that blocker,
 * surfaced in `OperationImpact`'s "Blocked by" section) disables the button so
 * the user sees why up front instead of a failed-mutation toast.
 *
 * Invalidates the MERGE key set, not the plain product one — for the same
 * reason {@link DuplicateVendorMergeFix} reaches past `vendorMutation…`. A
 * merge re-parents inventory, expenses, and projectUses and recomputes
 * dependent recipe costs, none of which `productMutationInvalidateKeys` covers.
 */
export function DuplicateProductMergeFix({
  variant,
  close,
}: {
  variant: DuplicateProductIdentity;
  close: () => void;
}) {
  const api = useTRPC();
  const first = variant.products[0];
  const [keepId, setKeepId] = useState<string | null>(first?.id ?? null);
  // Memoized because `previewInput` below depends on it: computed inline, this
  // would be a fresh array every render, which defeats that `useMemo` entirely
  // (see apps/web/CLAUDE.md on unstable hook deps). Never a render loop —
  // react-query hashes the query key structurally — but it did re-run the memo
  // and the zod `.parse()` `useOperationPreview` does on its input every render.
  const mergeIds = useMemo(
    () => variant.products.map((p) => p.id).filter((id) => id !== keepId),
    [variant.products, keepId],
  );

  const merge = useProblemCardMutation({
    mutationFn: api.product.merge.mutationOptions,
    success: (result) => `Merged into ${result.product.name}`,
    invalidateKeys: productMergeMutationInvalidateKeys,
    onSuccess: close,
  });

  // Re-derived every time `keepId` changes (the user can switch keepers), so
  // this can't reuse a static previewInput the way the vendor fix does.
  const previewInput = useMemo<PreviewOperationDraft | null>(
    () =>
      keepId && mergeIds.length > 0
        ? { operation: "merge", entity: "product", keepId, mergeIds }
        : null,
    [keepId, mergeIds],
  );
  const preview = useOperationPreview(previewInput, previewInput !== null);

  // Only the detector's own invariant (group.length >= 2) makes this
  // unreachable in practice; guard anyway rather than rendering a picker with
  // nothing to pick.
  if (!first) return null;

  return (
    <Stack gap="sm">
      <p className="text-muted-foreground text-xs">
        {variant.products.length} rows share the {variant.manufacturer}{" "}
        {variant.model} part number. Pick which one to keep — the rest merge
        into it.
      </p>
      <Stack gap="xs">
        {variant.products.map((p) => {
          const selected = p.id === keepId;
          return (
            <Button
              key={p.id}
              type="button"
              variant={selected ? "default" : "outline"}
              size="sm"
              className="h-auto justify-start py-1"
              onClick={() => setKeepId(p.id)}
            >
              <Check
                className={cn(
                  "size-3.5 shrink-0",
                  selected ? "opacity-100" : "opacity-0",
                )}
              />
              <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                <span className="truncate">{p.name}</span>
                <span
                  className={cn(
                    "text-2xs",
                    selected
                      ? "text-primary-foreground/80"
                      : "text-muted-foreground",
                  )}
                >
                  {p.upc ? `UPC ${p.upc} · ` : ""}
                  {p.sources.join(", ")}
                </span>
              </span>
            </Button>
          );
        })}
      </Stack>
      <OperationImpact
        preview={preview.data}
        isLoading={preview.isLoading}
        isError={preview.isError}
        onRetry={() => void preview.refetch()}
      />
      <Button
        size="sm"
        onClick={() => {
          if (!keepId || mergeIds.length === 0) return;
          merge.mutate({ keepId, mergeIds });
        }}
        disabled={
          !keepId ||
          mergeIds.length === 0 ||
          merge.isPending ||
          preview.data?.canProceed === false
        }
      >
        {merge.isPending
          ? "Merging…"
          : `Merge ${mergeIds.length === 1 ? "1 row" : `${mergeIds.length} rows`} in`}
      </Button>
    </Stack>
  );
}

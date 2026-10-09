import { ProblemItem } from "@cubby/schemas/problems";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { kernelMerge } from "~/entity/actions/merge-entity-actions";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { entityDetailFor } from "~/entity/entity-detail";
import {
  type EntityMergeResult,
  entityMergeMutationOptions,
} from "~/entity/entity-mutation";
import { EntityMergeDialog } from "~/entity/merge/entity-merge-dialog";
import { vendor } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/utils";
import {
  useActionMutation,
  useEntityActionMutation,
} from "~/ui/hooks/useActionMutation";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import { withoutSourceAlias, withoutSourceRef } from "./duplicate-claims";

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
    mutationFn: entityMergeMutationOptions("product"),
    success: (result: EntityMergeResult<"product">) =>
      `Merged into ${result.item.name}`,
    onSuccess: close,
  });
  const merge = kernelMerge("product", mutation);

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

type Claimant = { id: string; label: string; detail: string };

/**
 * Pick which record keeps a claim two or more records make on the same
 * provider identifier. Removing the claim from the others is the whole fix:
 * no record is deleted and nothing is merged.
 */
function ClaimKeeperFix({
  claimants,
  claim,
  pending,
  onConfirm,
}: {
  claimants: readonly Claimant[];
  claim: string;
  pending: boolean;
  onConfirm: (keepId: string) => void;
}) {
  const [keepId, setKeepId] = useState(claimants[0]?.id);
  const keeper = claimants.find((claimant) => claimant.id === keepId);
  return (
    <Stack gap="sm">
      <p className="text-xs text-muted-foreground">
        Choose the record that keeps {claim}. It is removed from the others; no
        record is deleted.
      </p>
      <Stack gap="xs">
        {claimants.map((claimant) => (
          <Button
            key={claimant.id}
            size="sm"
            variant={claimant.id === keepId ? "default" : "outline"}
            aria-pressed={claimant.id === keepId}
            className="h-auto justify-start py-1.5 text-left whitespace-normal"
            onClick={() => setKeepId(claimant.id)}
          >
            <span className="font-medium">{claimant.label}</span>
            <span className="ml-2 opacity-80">{claimant.detail}</span>
          </Button>
        ))}
      </Stack>
      <Button
        size="sm"
        disabled={pending || !keeper}
        onClick={() => keeper && onConfirm(keeper.id)}
      >
        {pending ? "Removing…" : `Keep on ${keeper?.label ?? "…"}`}
      </Button>
    </Stack>
  );
}

/**
 * Two transactions claim one provider reference: keep it on the chosen
 * transaction and drop it from the rest. The transactions stay; reconciling
 * which one is the real charge is the household's call, not this button's.
 */
export function DuplicateTransactionRefFix({
  variant,
  close,
}: {
  variant: ProblemItem<"duplicateFinancialTransactionSourceRefs">;
  close: () => void;
}) {
  const detail = entityDetailFor("financialTransaction");
  const transactions = useQueries({
    queries: variant.transactionIds.map((id) => detail.queryOptions(id)),
  }).map((query) => query.data);
  const update = useEntityActionMutation({
    mutationFn: entityMutationOptionsFactory("financialTransaction", "update"),
    entity: "financialTransaction",
    operation: "update",
    intent: "full",
    error: "Couldn't remove the reference",
  });
  const loaded = transactions.flatMap((row) => (row ? [row] : []));
  if (loaded.length < variant.transactionIds.length)
    return <p className="text-xs text-muted-foreground">Loading…</p>;

  return (
    <ClaimKeeperFix
      claim={`${variant.source} reference ${variant.externalId}`}
      pending={update.isPending}
      claimants={loaded.map((row) => ({
        id: row.id,
        label: row.displayName,
        detail:
          `${formatCurrency(row.amount)} ${row.postedDate ?? row.transactionDate ?? ""}`.trim(),
      }))}
      onConfirm={async (keepId) => {
        try {
          for (const row of loaded) {
            if (row.id === keepId) continue;
            await update.mutateAsync({
              id: row.id,
              data: { sourceRefs: withoutSourceRef(row.sourceRefs, variant) },
            });
          }
          toast.success("Reference removed from the other transactions");
          close();
        } catch {
          // SILENT: the mutation's onError already showed the error toast.
        }
      }}
    />
  );
}

/**
 * Two accounts claim one provider account id: keep the alias on the chosen
 * account and drop it from the rest, so imported rows resolve to one account.
 */
export function DuplicateAccountAliasFix({
  variant,
  close,
}: {
  variant: ProblemItem<"duplicateFinancialAccountSourceAliases">;
  close: () => void;
}) {
  const detail = entityDetailFor("financialAccount");
  const accounts = useQueries({
    queries: variant.accountIds.map((id) => detail.queryOptions(id)),
  }).map((query) => query.data);
  const update = useEntityActionMutation({
    mutationFn: entityMutationOptionsFactory("financialAccount", "update"),
    entity: "financialAccount",
    operation: "update",
    intent: "identity",
    error: "Couldn't remove the alias",
  });
  const loaded = accounts.flatMap((row) => (row ? [row] : []));
  if (loaded.length < variant.accountIds.length)
    return <p className="text-xs text-muted-foreground">Loading…</p>;

  return (
    <ClaimKeeperFix
      claim={`${variant.source} account ${variant.externalAccountId}`}
      pending={update.isPending}
      claimants={loaded.map((row) => ({
        id: row.id,
        label: row.name,
        detail: `${row.sourceAliases.length} alias${row.sourceAliases.length === 1 ? "" : "es"}`,
      }))}
      onConfirm={async (keepId) => {
        try {
          for (const row of loaded) {
            if (row.id === keepId) continue;
            await update.mutateAsync({
              id: row.id,
              data: {
                sourceAliases: withoutSourceAlias(row.sourceAliases, variant),
              },
            });
          }
          toast.success("Alias removed from the other accounts");
          close();
        } catch {
          // SILENT: the mutation's onError already showed the error toast.
        }
      }}
    />
  );
}

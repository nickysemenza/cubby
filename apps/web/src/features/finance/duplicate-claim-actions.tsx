import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { ProblemItem } from "@cubby/schemas/problems";
import { countLabel } from "@cubby/shared/pluralize";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { entityDetailFor } from "~/entity/entity-detail";
import { useEntityActionMutation } from "~/entity/hooks/use-action-mutation";
import type { WorkActionProps } from "~/entity/work-queue/work-actions";
import { ProblemItemsAction } from "~/features/work-queue/problem-items-action";
import { formatCurrency } from "~/lib/number-format";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import { withoutSourceAlias, withoutSourceRef } from "./duplicate-claims";

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
              data: {
                sourceRefs: withoutSourceRef(
                  fieldValueOf(row.fields.sourceRefs) ?? [],
                  variant,
                ),
              },
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
        detail: countLabel(row.sourceAliases.length, "alias"),
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

/** `duplicateFinancialTransactionSourceRefs:choose-keeper`. */
export function DuplicateTransactionRefAction(props: WorkActionProps) {
  return (
    <ProblemItemsAction
      {...props}
      problemKey="duplicateFinancialTransactionSourceRefs"
    >
      {(item, close) => (
        <DuplicateTransactionRefFix variant={item} close={close} />
      )}
    </ProblemItemsAction>
  );
}

/** `duplicateFinancialAccountSourceAliases:choose-keeper`. */
export function DuplicateAccountAliasAction(props: WorkActionProps) {
  return (
    <ProblemItemsAction
      {...props}
      problemKey="duplicateFinancialAccountSourceAliases"
    >
      {(item, close) => (
        <DuplicateAccountAliasFix variant={item} close={close} />
      )}
    </ProblemItemsAction>
  );
}

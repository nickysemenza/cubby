import { z } from "zod";

import { ingredient } from "~/app/ingredients/ingredient.functions";
import { vendor } from "~/app/vendors/vendor.functions";
import {
  entityMergeMutationOptions,
  type MergeCommand,
} from "~/entities/entity-mutation.functions";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";

import { useActionMutation } from "../hooks/useActionMutation";
import { EntityMergeDialog } from "../merge/entity-merge-dialog";
import { VerbMenuItem } from "./action-verb-ui";
import { defineEntityAction } from "./entity-action-definition";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";
import { useStagedDialogAction } from "./use-staged-dialog-action";

type MergeEntity = "ingredient" | "product" | "purchase" | "vendor";
type MergeRow = EntityActionRow & { name: string };
export type MergeMutation<TOutput> = {
  mutateAsync: (input: {
    keepId: string;
    mergeIds: string[];
  }) => Promise<TOutput>;
  isPending: boolean;
};

const asMergeRow = (row: EntityActionRow): MergeRow => ({
  ...row,
  name: row.name || row.id,
});

const purchaseMergeRowSchema = z.object({ vendorId: z.string() }).passthrough();

export function useStagedMerge<TOutput>(
  entity: MergeEntity,
  mutation: MergeMutation<TOutput>,
): EntityActionHandles {
  const { items: rows, stage, finish } = useStagedDialogAction(asMergeRow);

  return {
    run: stage,
    rowMenuItem: (row) => (
      <VerbMenuItem
        verb="merge"
        disabled={mutation.isPending}
        disabledReason={
          mutation.isPending
            ? `A ${entity} merge is already running.`
            : undefined
        }
        onSelect={(event) => {
          event.stopPropagation();
          void stage([row]);
        }}
      />
    ),
    availability: () =>
      mutation.isPending
        ? {
            status: "disabled",
            reason: `A ${entity} merge is already running.`,
          }
        : { status: "available" },
    dialog: (
      <EntityMergeDialog
        entity={entity}
        rows={rows}
        keeper={rows[0]}
        initialAliasIds={rows.slice(1).map((row) => row.id)}
        open={rows.length > 0}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
        onConfirm={async (keepId, mergeIds) => {
          await mutation.mutateAsync({ keepId, mergeIds });
          finish(true);
        }}
        isPending={mutation.isPending}
      />
    ),
  };
}

function useMergeVendorsEntityAction(): EntityActionHandles {
  const mutation = useActionMutation({
    mutationFn: vendor.merge.mutationOptions,
    success: "Vendors merged",
  });
  return useStagedMerge("vendor", mutation);
}

function useMergeIngredientsEntityAction(): EntityActionHandles {
  const mutation = useActionMutation({
    mutationFn: ingredient.merge.mutationOptions,
    success: (result) =>
      savedWithBackgroundWork(result.sideEffects, "Ingredients merged"),
  });
  return useStagedMerge("ingredient", mutation);
}

/** A kernel merge mutation behind the `{ keepId, mergeIds }` dialog shape. */
export const kernelMerge = <TOutput,>(
  entity: MergeCommand["entity"],
  mutation: {
    mutate: (command: MergeCommand) => void;
    mutateAsync: (command: MergeCommand) => Promise<TOutput>;
    isPending: boolean;
  },
) => {
  type Data = Parameters<MergeMutation<TOutput>["mutateAsync"]>[0];
  return {
    isPending: mutation.isPending,
    mutate: (data: Data) => mutation.mutate({ action: "merge", entity, data }),
    mutateAsync: (data: Data) =>
      mutation.mutateAsync({ action: "merge", entity, data }),
  };
};

function useMergeProductsEntityAction(): EntityActionHandles {
  const mutation = useActionMutation({
    mutationFn: entityMergeMutationOptions("product"),
    success: "Products merged",
  });
  return useStagedMerge("product", kernelMerge("product", mutation));
}

function useMergePurchasesEntityAction(): EntityActionHandles {
  const mutation = useActionMutation({
    mutationFn: entityMergeMutationOptions("purchase"),
    success: "Purchases merged",
  });
  const action = useStagedMerge("purchase", kernelMerge("purchase", mutation));
  const baseAvailability = action.availability;
  return {
    ...action,
    availability: (context) => {
      const base = baseAvailability?.(context);
      if (base && base.status !== "available") return base;
      if (context.rows.length < 2) return { status: "available" };
      const vendorIds = context.rows.map((row) => {
        const parsed = purchaseMergeRowSchema.safeParse(row);
        return parsed.success ? parsed.data.vendorId : null;
      });
      return vendorIds.every(
        (vendorId) => vendorId !== null && vendorId === vendorIds[0],
      )
        ? { status: "available" }
        : {
            status: "disabled",
            reason: "Purchases must share a vendor before they can be merged.",
          };
    },
  };
}

export const mergeEntityActionDefinitions = [
  defineEntityAction({
    verb: "merge",
    entities: ["ingredient"],
    arity: "both",
    minSelection: 2,
    group: "organize",
    priority: 100,
    use: useMergeIngredientsEntityAction,
  }),
  defineEntityAction({
    verb: "merge",
    entities: ["product"],
    arity: "both",
    minSelection: 2,
    group: "organize",
    priority: 100,
    use: useMergeProductsEntityAction,
  }),
  defineEntityAction({
    verb: "merge",
    entities: ["vendor"],
    arity: "both",
    minSelection: 2,
    group: "organize",
    priority: 100,
    use: useMergeVendorsEntityAction,
  }),
  defineEntityAction({
    verb: "merge",
    entities: ["purchase"],
    arity: "both",
    minSelection: 2,
    group: "organize",
    priority: 100,
    use: useMergePurchasesEntityAction,
  }),
] as const;

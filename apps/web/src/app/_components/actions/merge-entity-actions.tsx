import { useCallback, useRef, useState } from "react";

import { purchase } from "~/app/purchases/purchase.functions";
import { vendor } from "~/app/vendors/vendor.functions";

import { useActionMutation } from "../hooks/useActionMutation";
import { EntityMergeDialog } from "../merge/entity-merge-dialog";
import { VerbMenuItem } from "./action-verb-ui";
import type {
  EntityActionDefinition,
  EntityActionHandles,
  EntityActionRow,
} from "./entity-actions";

type MergeEntity = "purchase" | "vendor";
type MergeRow = EntityActionRow & { name: string };
type MergeMutation = {
  mutateAsync: (input: {
    keepId: string;
    mergeIds: string[];
  }) => Promise<unknown>;
  isPending: boolean;
};

function useStagedMerge(
  entity: MergeEntity,
  mutation: MergeMutation,
): EntityActionHandles {
  const [rows, setRows] = useState<MergeRow[]>([]);
  const resolveRef = useRef<((result: { success: boolean }) => void) | null>(
    null,
  );

  const finish = useCallback((success: boolean) => {
    setRows([]);
    resolveRef.current?.({ success });
    resolveRef.current = null;
  }, []);
  const stage = useCallback((next: readonly EntityActionRow[]) => {
    setRows(next.map((row) => ({ ...row, name: row.name || row.id })));
    return new Promise<{ success: boolean }>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

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

function useMergePurchasesEntityAction(): EntityActionHandles {
  const mutation = useActionMutation({
    mutationFn: purchase.merge.mutationOptions,
    success: "Purchases merged",
  });
  const action = useStagedMerge("purchase", mutation);
  const baseAvailability = action.availability;
  return {
    ...action,
    availability: (context) => {
      const base = baseAvailability?.(context);
      if (base && base.status !== "available") return base;
      if (context.rows.length < 2) return { status: "available" };
      const vendorIds = context.rows.map((row) =>
        "vendorId" in row && typeof row.vendorId === "string"
          ? row.vendorId
          : null,
      );
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
  {
    verb: "merge",
    entities: ["vendor"],
    arity: "both",
    minSelection: 2,
    group: "organize",
    priority: 100,
    use: useMergeVendorsEntityAction,
  },
  {
    verb: "merge",
    entities: ["purchase"],
    arity: "both",
    minSelection: 2,
    group: "organize",
    priority: 100,
    use: useMergePurchasesEntityAction,
  },
] as const satisfies readonly EntityActionDefinition[];

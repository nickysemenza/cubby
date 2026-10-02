import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { TargetedProductBulkEnrichmentDialog } from "~/app/purchases/targeted-import-launch";

import { VerbMenuItem } from "./action-verb-ui";
import { defineEntityAction } from "./entity-action-definition";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";
import { useStagedDialogAction } from "./use-staged-dialog-action";

interface ProductRosterActionRow extends EntityActionRow {
  name: string;
}

const asProductRow = (row: EntityActionRow): ProductRosterActionRow => ({
  ...row,
  name: row.name || row.id,
});

function usePrintProductLabelsAction(): EntityActionHandles {
  const navigate = useNavigate();
  const run = useCallback(
    async (rows: readonly EntityActionRow[]) => {
      await navigate({
        to: "/labels",
        search: { codes: rows.map((row) => row.id).join(",") },
      });
      return { success: true };
    },
    [navigate],
  );
  return {
    run,
    rowMenuItem: (row) => (
      <VerbMenuItem verb="printLabels" onSelect={() => void run([row])} />
    ),
    dialog: null,
  };
}

function useEnrichProductsAction(): EntityActionHandles {
  const { items: rows, stage, finish } = useStagedDialogAction(asProductRow);
  return {
    run: stage,
    rowMenuItem: () => null,
    dialog: (
      <TargetedProductBulkEnrichmentDialog
        open={rows.length > 0}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
        products={rows.map((row) => ({ id: row.id, name: row.name }))}
        onFinished={finish}
      />
    ),
  };
}

export const productRosterEntityActionDefinitions = [
  defineEntityAction({
    verb: "enrichProducts",
    entities: ["product"],
    arity: "both",
    surfaces: ["selection"],
    group: "organize",
    priority: 150,
    preserveSelection: true,
    use: useEnrichProductsAction,
  }),
  defineEntityAction({
    id: "print-labels",
    verb: "printLabels",
    entities: ["product"],
    arity: "both",
    surfaces: ["row", "selection", "inspector", "detail"],
    group: "organize",
    priority: 200,
    placement: { inspector: "overflow", detail: "overflow" },
    preserveSelection: true,
    use: usePrintProductLabelsAction,
  }),
] as const;

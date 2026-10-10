import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { VerbMenuItem } from "./action-verb-ui";
import { defineEntityAction } from "./entity-action-definition";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";

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

export const productRosterEntityActionDefinitions = [
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

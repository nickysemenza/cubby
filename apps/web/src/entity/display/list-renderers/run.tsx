import { fieldValueOf } from "@cubby/schemas/field-envelope";

import { textCellData } from "~/ui/data-table/cell-data";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";

import type { ListRenderer, ListRowOf } from "../list-renderer-types";

type RunRow = ListRowOf<"run">;

const costLabel = (row: RunRow) =>
  fieldValueOf(row.fields.chargedCostLabel) ?? null;

const aiCost: ListRenderer<"run"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor(costLabel, {
        id: "chargedCost",
        header: "AI cost",
        enableSorting: false,
        meta: attachCubbyColumnMeta<RunRow>({
          className: "w-28",
          cellData: textCellData("text", costLabel),
          mobile: { slot: "meta", priority: 50 },
        }),
        cell: ({ getValue }) => (
          <span className="tabular-nums">{getValue()}</span>
        ),
      }),
    );
  });

export const runListRenderers = {
  "run-ai-cost": aiCost,
} as const;

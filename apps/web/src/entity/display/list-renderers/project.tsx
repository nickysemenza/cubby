import { useDenseCell } from "~/ui/common/stacked-value";
import { textCellData } from "~/ui/data-table/cell-data";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { CellBar } from "~/ui/data-table/visuals/cell-visual";

import type { ListRenderer, ListRowOf } from "../list-renderer-types";

const completion = (row: ListRowOf<"project">) =>
  row.rollup.taskCount > 0
    ? row.rollup.doneTaskCount / row.rollup.taskCount
    : null;

const taskProgress: ListRenderer<"project"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor(completion, {
        id: "taskProgress",
        header: "Tasks",
        enableSorting: false,
        meta: attachCubbyColumnMeta<ListRowOf<"project">>({
          className: "w-32",
          mono: true,
          cellData: textCellData("text", (row) => row.taskProgress),
          mobile: { slot: "meta", priority: 30 },
        }),
        cell: function TaskProgressCell({ row, getValue }) {
          const dense = useDenseCell();
          const { doneTaskCount, taskCount } = row.original.rollup;
          const value =
            taskCount === 0 ? "No tasks" : `${doneTaskCount} / ${taskCount}`;
          if (!dense) return <span>{value}</span>;
          return (
            <CellBar
              value={getValue()}
              maximum={1}
              label={
                taskCount === 0
                  ? "No tasks"
                  : `${doneTaskCount} of ${taskCount} own tasks complete`
              }
            >
              <span className="text-muted-foreground">{value}</span>
            </CellBar>
          );
        },
      }),
    );
  });

export const projectListRenderers = { "task-progress": taskProgress } as const;

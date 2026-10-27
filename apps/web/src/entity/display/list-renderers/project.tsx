import { fieldValueOf } from "@cubby/schemas/field-envelope";

import { useDenseCell } from "~/ui/common/stacked-value";
import { textCellData } from "~/ui/data-table/cell-data";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { CellBar } from "~/ui/data-table/visuals/cell-visual";
import { FieldValueMark } from "~/ui/derived/value-mark";

import type { ListRenderer, ListRowOf } from "../list-renderer-types";

const completion = (row: ListRowOf<"project">) => {
  const rollup = fieldValueOf(row.fields.rollup);
  return rollup && rollup.taskCount > 0
    ? rollup.doneTaskCount / rollup.taskCount
    : null;
};

const taskProgress: ListRenderer<"project"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor(completion, {
        id: "taskProgress",
        header: "Tasks",
        enableSorting: false,
        meta: attachCubbyColumnMeta<ListRowOf<"project">>({
          readFields: ["rollup"],
          className: "w-32",
          mono: true,
          cellData: textCellData("text", (row) => {
            const effectiveRowTaskProgress = fieldValueOf(
              row.fields.taskProgress,
            );
            return effectiveRowTaskProgress;
          }),
          mobile: { slot: "meta", priority: 30 },
        }),
        cell: function TaskProgressCell({ row, getValue }) {
          const dense = useDenseCell();
          const rollup = fieldValueOf(row.original.fields.rollup);
          if (!rollup)
            return (
              <FieldValueMark envelope={row.original.fields.rollup}>
                Updating…
              </FieldValueMark>
            );
          const { doneTaskCount, taskCount } = rollup;
          const value =
            taskCount === 0 ? "No tasks" : `${doneTaskCount} / ${taskCount}`;
          if (!dense)
            return (
              <FieldValueMark envelope={row.original.fields.rollup}>
                {value}
              </FieldValueMark>
            );
          return (
            <FieldValueMark envelope={row.original.fields.rollup}>
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
            </FieldValueMark>
          );
        },
      }),
    );
  });

export const projectListRenderers = { "task-progress": taskProgress } as const;

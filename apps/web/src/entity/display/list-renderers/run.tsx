import { DateDisplay } from "~/ui/common/date-display";
import { RunWorkProgress } from "~/ui/common/run-work-progress";
import { textCellData } from "~/ui/data-table/cell-data";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { NoneValue } from "~/ui/primitives/none-value";

import type { ListRenderer, ListRowOf } from "../list-renderer-types";

type RunRow = ListRowOf<"run">;
const workLabel = (row: RunRow) => {
  const work = row.workProgress?.current;
  return work
    ? `${work.processed}${work.total === null ? "" : ` / ${work.total}`} ${work.unit}`
    : null;
};
const activityAt = (row: RunRow) => row.activityAt;

function WorkValue({ row }: { row: RunRow }) {
  const sample = row.workProgress?.current;
  return sample ? (
    <RunWorkProgress sample={sample} status={row.status} />
  ) : (
    <span className="text-muted-foreground">Unavailable</span>
  );
}

const throughput: ListRenderer<"run"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor(workLabel, {
        id: "workProgress",
        header: "Work",
        enableSorting: false,
        meta: attachCubbyColumnMeta<RunRow>({
          className: "w-56",
          mono: true,
          cellData: textCellData("text", workLabel),
          mobile: { slot: "meta", priority: 30 },
        }),
        cell: ({ row }) => <WorkValue row={row.original} />,
      }),
    );
  });

const activity: ListRenderer<"run"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor(activityAt, {
        id: "activityAt",
        header: "Activity",
        enableSorting: false,
        meta: attachCubbyColumnMeta<RunRow>({
          className: "w-28",
          cellData: textCellData("text", activityAt),
          mobile: { slot: "meta", priority: 40 },
        }),
        cell: ({ getValue }) => {
          const at = getValue();
          return at ? (
            <span className="text-muted-foreground">
              <DateDisplay timestamp={at} />
            </span>
          ) : (
            <NoneValue />
          );
        },
      }),
    );
  });

export const runListRenderers = {
  "run-throughput": throughput,
  "run-activity": activity,
} as const;

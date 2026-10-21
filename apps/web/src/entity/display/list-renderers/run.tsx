import { readRunWorkPhase } from "@cubby/schemas/run-work-progress";

import { DateDisplay } from "~/ui/common/date-display";
import { StackedValue, useDenseCell } from "~/ui/common/stacked-value";
import { textCellData } from "~/ui/data-table/cell-data";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { CellBar } from "~/ui/data-table/visuals/cell-visual";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
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
  const dense = useDenseCell();
  const now = useDisplayNow() ?? Date.now();
  const sample = row.workProgress?.current;
  if (!sample)
    return <span className="text-muted-foreground">Unavailable</span>;
  const work = readRunWorkPhase(
    sample,
    row.status,
    new Date(now),
    sample.state === "waiting",
  );
  const historical = work.state === "completed" || work.state === "failed";
  const rate =
    work.ratePerSecond === null
      ? "Rate unavailable"
      : historical
        ? `${(work.ratePerSecond * 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${work.unit}/min recorded`
        : work.estimateState === "current"
          ? `${(work.ratePerSecond * 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${work.unit}/min`
          : work.estimateState === "paused"
            ? "Paused"
            : "Stale sample";
  if (!dense)
    return (
      <span>
        {workLabel(row)}; {rate}
      </span>
    );
  return (
    <CellBar
      value={work.total === null ? null : work.processed}
      maximum={work.total ?? 0}
      label={`${work.label}; ${workLabel(row)}; ${rate}`}
    >
      <span className="text-muted-foreground">
        <StackedValue
          primary={workLabel(row) ?? "Unavailable"}
          secondary={rate}
        />
      </span>
    </CellBar>
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

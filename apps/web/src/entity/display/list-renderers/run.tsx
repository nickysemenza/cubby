import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { fieldEmptyLabel } from "@cubby/schemas/field-envelope-presentation";

import { textCellData } from "~/ui/data-table/cell-data";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { RunWaitCell } from "~/ui/records/run-wait";
import { RunWorkProgress } from "~/ui/records/run-work-progress";
import { NoneValue } from "~/ui/text/none-value";
import { DateDisplay } from "~/ui/values/date-display";

import type { ListRenderer, ListRowOf } from "../list-renderer-types";

type RunRow = ListRowOf<"run">;
const workLabel = (row: RunRow) => {
  const effectiveRowWorkProgress = fieldValueOf(row.fields.workProgress);

  const work = effectiveRowWorkProgress?.current;
  return work
    ? `${work.processed}${work.total === null ? "" : ` / ${work.total}`} ${work.unit}`
    : null;
};
const activityAt = (row: RunRow) => {
  const effectiveRowActivityAt = fieldValueOf(row.fields.activityAt);
  return effectiveRowActivityAt;
};

function WorkValue({ row }: { row: RunRow }) {
  const sample = fieldValueOf(row.fields.workProgress)?.current;
  return sample ? (
    <RunWorkProgress sample={sample} status={row.status} />
  ) : (
    <span className="text-muted-foreground">
      {fieldEmptyLabel(row.fields.workProgress)}
    </span>
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

const waitLabel = (row: RunRow) =>
  fieldValueOf(row.fields.waitingOn)?.label ?? null;

const waitingOn: ListRenderer<"run"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor(waitLabel, {
        id: "waitingOn",
        header: "Waiting on",
        enableSorting: false,
        meta: attachCubbyColumnMeta<RunRow>({
          className: "w-64",
          cellData: textCellData("text", waitLabel),
          mobile: { slot: "meta", priority: 30 },
        }),
        cell: ({ row }) => {
          const wait = fieldValueOf(row.original.fields.waitingOn);
          return wait ? <RunWaitCell wait={wait} /> : <NoneValue />;
        },
      }),
    );
  });

export const runListRenderers = {
  "run-waiting-on": waitingOn,
  "run-throughput": throughput,
  "run-activity": activity,
  "run-ai-cost": aiCost,
} as const;

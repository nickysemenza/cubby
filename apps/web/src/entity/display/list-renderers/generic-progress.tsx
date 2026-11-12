import type { Entity } from "@cubby/schemas/entity";
import { progressValueSchema } from "@cubby/schemas/progress";
import type { QueryClient } from "@tanstack/react-query";
import { useContext } from "react";
import { z } from "zod";

import { readRecordField } from "~/entity/entity-references";
import { entityMetadata } from "~/entity/metadata";
import { textCellData } from "~/ui/data-table/cell-data";
import { RowLinesContext } from "~/ui/data-table/density";
import {
  createCubbyColumnCollection,
  type CubbyColumnCollection,
  type CubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { ProgressMeter } from "~/ui/feedback/progress-meter";
import { NoneValue } from "~/ui/text/none-value";

import { readRecordState } from "./generic-state";

const optionalProgress = progressValueSchema.nullish();
const optionalText = z.string().nullish();

function ProgressCell({
  queryClient,
  entity,
  row,
}: {
  queryClient: QueryClient;
  entity: Entity;
  row: object;
}) {
  const lines = useContext(RowLinesContext);
  const progress = entityMetadata(queryClient, entity).summary.progress;
  const value = progress
    ? readRecordField(row, progress.field, optionalProgress)
    : null;
  if (!progress || !value) return <NoneValue />;
  const state = readRecordState(queryClient, entity, row);
  const paused = state?.wait?.reason === "paused";
  // Two-line rows carry the note on the title's second line; a single line
  // keeps the label whole and lets only the note truncate.
  if (lines === "double")
    return <ProgressMeter value={value} variant="block" paused={paused} />;
  const note = progress.note
    ? readRecordField(row, progress.note, optionalText)
    : null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <ProgressMeter
        value={value}
        variant="row"
        paused={paused}
        className="shrink-0"
      />
      {note ? (
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          · {note}
        </span>
      ) : null}
    </span>
  );
}

/** "394 of 412 products", the meter's own words, for copy and fit. */
const progressText = (value: z.infer<typeof progressValueSchema>) =>
  value.total === null
    ? `${value.done} ${value.unit}`
    : `${value.done} of ${value.total} ${value.unit}`;

/**
 * The shared `progress` list cell: the declared `presentation.progress`
 * field drawn with `ProgressMeter`, its note appended in single-line rows.
 */
export const progressListRenderer =
  (entity: Entity) =>
  <TRow extends object>(
    helper: CubbyColumnHelper<TRow>,
    queryClient: QueryClient,
  ): CubbyColumnCollection<TRow> =>
    createCubbyColumnCollection<TRow>((add) => {
      const progress = entityMetadata(queryClient, entity).summary.progress;
      if (!progress)
        throw new Error(
          `${entity} names the progress renderer without progress`,
        );
      const read = (row: TRow) =>
        readRecordField(row, progress.field, optionalProgress) ?? null;
      add(
        helper.accessor(read, {
          id: progress.field,
          enableSorting: false,
          meta: attachCubbyColumnMeta<TRow>({
            widthKind: "progress",
            cellData: textCellData("text", (row) => {
              const value = read(row);
              return value ? progressText(value) : null;
            }),
            mobile: { slot: "meta", priority: 20 },
          }),
          cell: ({ row }) => (
            <ProgressCell
              queryClient={queryClient}
              entity={entity}
              row={row.original}
            />
          ),
        }),
      );
    });

import type { Entity } from "@cubby/schemas/entity";
import {
  type EntityPhase,
  optionPhase,
} from "@cubby/schemas/entity-definitions/definition";
import { runWaitingOn } from "@cubby/schemas/job";
import { kernelStage, type KernelStage } from "@cubby/schemas/kernel/stage";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { readRecordField } from "~/entity/entity-references";
import { entityMetadata } from "~/entity/metadata";
import { textCellData } from "~/ui/data-table/cell-data";
import {
  createCubbyColumnCollection,
  type CubbyColumnCollection,
  type CubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { StateBadge } from "~/ui/records/state-badge";
import { NoneValue } from "~/ui/text/none-value";

const optionalText = z.string().nullish();
const optionalBoolean = z.boolean().nullish();
const optionalWait = runWaitingOn.nullish();

type StateOption = {
  value: string;
  label: string;
  color?: string;
  phase?: EntityPhase;
  stage?: KernelStage;
  closed?: true;
  glyph?: { phosphor: string };
};

/** `presentation.state` as every entity reads it; most name only `field`. */
type DeclaredState = {
  field: string;
  reason?: string;
  wait?: string;
  stalled?: string;
};

/** A roster field's options: its select options, else its display options. */
export function fieldOptions(
  queryClient: QueryClient,
  entity: Entity,
  key: string,
): readonly StateOption[] {
  const field = entityMetadata(queryClient, entity).fields.fields.find(
    (candidate) => candidate.key === key,
  );
  const options: readonly unknown[] =
    field?.control?.options ?? field?.display.valueOptions ?? [];
  return z
    .array(
      z.looseObject({
        value: z.string(),
        label: z.string(),
        color: z.string().optional(),
        phase: z.enum(["needs", "active", "finished"]).optional(),
        stage: kernelStage.optional(),
        closed: z.literal(true).optional(),
        glyph: z.looseObject({ phosphor: z.string() }).optional(),
      }),
    )
    .parse(options);
}

/** The parts of one row's `presentation.state`, read from the declaration. */
export function readRecordState<TRow extends object>(
  queryClient: QueryClient,
  entity: Entity,
  row: TRow,
) {
  const state: DeclaredState | null = entityMetadata(queryClient, entity)
    .summary.state;
  if (!state) return null;
  const value = readRecordField(row, state.field, optionalText);
  if (!value) return null;
  const option = fieldOptions(queryClient, entity, state.field).find(
    (candidate) => candidate.value === value,
  ) ?? { value, label: value };
  return {
    option,
    phase: optionPhase(option),
    /** A declared Stuck option is a failure outcome. */
    failed: option.stage === "stuck",
    reason: state.reason
      ? readRecordField(row, state.reason, optionalText)
      : null,
    wait: state.wait
      ? (readRecordField(row, state.wait, optionalWait) ?? undefined)
      : undefined,
    stalled: state.stalled
      ? readRecordField(row, state.stalled, optionalBoolean) === true
      : false,
  };
}

/**
 * The shared `state` list cell: the declared `presentation.state` field
 * drawn once with `StateBadge`, its reason, wait and stalled flag merged in.
 */
export const stateListRenderer =
  (entity: Entity) =>
  <TRow extends object>(
    helper: CubbyColumnHelper<TRow>,
    queryClient: QueryClient,
  ): CubbyColumnCollection<TRow> =>
    createCubbyColumnCollection<TRow>((add) => {
      const state = entityMetadata(queryClient, entity).summary.state;
      if (!state)
        throw new Error(`${entity} names the state renderer without state`);
      const label = (row: TRow) =>
        readRecordState(queryClient, entity, row)?.option.label ?? null;
      add(
        helper.accessor(
          (row) => readRecordField(row, state.field, optionalText) ?? null,
          {
            id: state.field,
            meta: attachCubbyColumnMeta<TRow>({
              widthKind: "state",
              cellData: textCellData("text", label),
              mobile: { slot: "trailing", priority: 10 },
            }),
            cell: ({ row }) => {
              const record = readRecordState(queryClient, entity, row.original);
              return record ? (
                <StateBadge
                  option={record.option}
                  phase={record.phase}
                  reason={record.reason}
                  wait={record.wait}
                  stalled={record.stalled}
                />
              ) : (
                <NoneValue />
              );
            },
          },
        ),
      );
    });

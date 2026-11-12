import {
  optionPhase,
  type CompiledEntityPresentation,
} from "@cubby/schemas/entity-definitions/definition";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { progressValueSchema } from "@cubby/schemas/progress";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import type {
  DetailRecordOf,
  GenericDetailEntity,
} from "~/entity/entity-detail/detail-record";
import { recordStateOf } from "~/entity/entity-detail/record-header";
import { entityMetadata } from "~/entity/metadata";
import { readPathValue } from "~/entity/read-path";
import { ProgressMeter } from "~/ui/feedback/progress-meter";
import { StateBadge } from "~/ui/records/state-badge";
import { NoneValue } from "~/ui/text/none-value";

import type { DetailFieldRenderer } from "../entity-display";

type Field = EntityFieldModel["fields"][number];
type DetailRecord = DetailRecordOf<GenericDetailEntity>;
/** The runtime's own detail rows (`SHARED_DETAIL_RENDERERS` in native coverage). */
type SharedDetailRendererId = "state" | "progress";

const optionSchema = z.looseObject({
  value: z.string(),
  label: z.string(),
  color: z.string().optional(),
  phase: z.enum(["needs", "active", "finished"]).optional(),
  closed: z.literal(true).optional(),
});

const readField = (record: DetailRecord, field: Field) =>
  readPathValue(record, field.display.readPath ?? field.readKey ?? field.key);

/**
 * A state field as `StateBadge` draws it in the header. The declared
 * `presentation.state` field carries its reason, wait and stalled flag; any
 * other field draws its option alone.
 */
function stateRenderer(
  entity: GenericDetailEntity,
  field: Field,
): DetailFieldRenderer<DetailRecord> {
  return (record, queryClient) => {
    const { state }: CompiledEntityPresentation = entityMetadata(
      queryClient,
      entity,
    ).summary;
    if (state?.field === field.key) {
      const declared = recordStateOf(queryClient, entity, record);
      return {
        value: declared ? (
          <StateBadge
            size="header"
            option={declared.option}
            phase={declared.phase}
            reason={declared.reason}
            wait={declared.wait}
            stalled={declared.stalled}
            failed={declared.failed}
          />
        ) : (
          <NoneValue />
        ),
      };
    }
    const raw = readField(record, field);
    const options = z
      .array(optionSchema)
      .catch([])
      .parse(field.control?.options ?? field.display.valueOptions ?? []);
    const option = options.find((candidate) => candidate.value === raw);
    if (typeof raw !== "string") return { value: <NoneValue /> };
    return {
      value: (
        <StateBadge
          size="header"
          option={{ label: option?.label ?? raw, color: option?.color }}
          phase={option ? optionPhase(option) : "active"}
          failed={
            option?.color === "destructive" ||
            option?.color === "var(--destructive)"
          }
        />
      ),
    };
  };
}

/** A `ProgressValue` field as a full-width `ProgressMeter`, with the declared note. */
function progressRenderer(
  entity: GenericDetailEntity,
  field: Field,
): DetailFieldRenderer<DetailRecord> {
  return (record, queryClient) => {
    const value = progressValueSchema.safeParse(readField(record, field));
    if (!value.success) return { value: <NoneValue /> };
    const { progress }: CompiledEntityPresentation = entityMetadata(
      queryClient,
      entity,
    ).summary;
    const note =
      progress?.field === field.key && progress.note
        ? readPathValue(record, progress.note)
        : undefined;
    return {
      value: (
        <ProgressMeter
          value={value.data}
          variant="block"
          note={typeof note === "string" && note !== "" ? note : undefined}
          className="w-full max-w-80"
        />
      ),
    };
  };
}

const SHARED = {
  state: stateRenderer,
  progress: progressRenderer,
} satisfies Record<
  SharedDetailRendererId,
  (
    entity: GenericDetailEntity,
    field: Field,
  ) => DetailFieldRenderer<DetailRecord>
>;

export const isSharedDetailRenderer = (
  id: string,
): id is SharedDetailRendererId => Object.hasOwn(SHARED, id);

/**
 * The shared renderer a field gets: a declared `state`/`progress` id, else the
 * field `presentation.state` or `presentation.progress` names.
 */
export function sharedDetailRenderer(
  queryClient: QueryClient,
  entity: GenericDetailEntity,
  field: Field,
): DetailFieldRenderer<DetailRecord> | undefined {
  const declared = field.display.renderer?.detail;
  if (declared !== null && declared !== undefined)
    return isSharedDetailRenderer(declared)
      ? SHARED[declared](entity, field)
      : undefined;
  const { state, progress }: CompiledEntityPresentation = entityMetadata(
    queryClient,
    entity,
  ).summary;
  if (state?.field === field.key) return SHARED.state(entity, field);
  if (progress?.field === field.key) return SHARED.progress(entity, field);
  return undefined;
}

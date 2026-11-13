import { entitySchema } from "@cubby/schemas/entity";
import {
  optionPhase,
  type CompiledEntityPresentation,
  type EntityPhase,
} from "@cubby/schemas/entity-definitions/definition";
import { displayItem } from "@cubby/schemas/entity-definitions/label-field";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { runWaitingOn, type RunWaitingOn } from "@cubby/schemas/job";
import { kernelStage, type KernelStage } from "@cubby/schemas/kernel/stage";
import type { QueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { z } from "zod";

import { renderDetailFieldValue } from "~/entity/display/entity-display";
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { entityMetadata } from "~/entity/metadata";
import { NotRecordedValue } from "~/ui/records/facts";

import { readPathValue } from "../read-path";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

type Field = EntityFieldModel["fields"][number];

const fieldOf = (
  queryClient: QueryClient,
  entity: GenericDetailEntity,
  key: string,
): Field | undefined =>
  entityMetadata(queryClient, entity).fields.fields.find(
    (candidate: Field) => candidate.key === key,
  );

const readField = (record: DetailRecordOf<GenericDetailEntity>, field: Field) =>
  readPathValue(record, field.display.readPath ?? field.readKey ?? field.key);

const stagedOption = z.looseObject({ stage: kernelStage.optional() });

/** The option's declared stage; colour never stands in for it. */
function optionStage(option: unknown): KernelStage | undefined {
  return stagedOption.safeParse(option).data?.stage;
}

/** The roster option a stored enum value names. */
function optionOf(field: Field, raw: unknown) {
  if (typeof raw !== "string") return undefined;
  const options = field.control?.options ?? field.display.valueOptions ?? [];
  return options.find((option) => option.value === raw);
}

/** What `StateBadge` draws for the record's declared `presentation.state`. */
export interface RecordState {
  option: { label: string; stage?: KernelStage };
  phase: EntityPhase;
  reason: string | null;
  wait: RunWaitingOn | undefined;
  stalled: boolean;
  failed: boolean;
}

/**
 * The record's state from `presentation.state`: the option, its phase, the
 * reason text, the wait and the stalled flag. A destructive option is a
 * failure; the badge draws it as one. Null when undeclared or unset.
 */
export function recordStateOf<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
): RecordState | null {
  const { state }: CompiledEntityPresentation = entityMetadata(
    queryClient,
    entity,
  ).summary;
  if (state === null) return null;
  const field = fieldOf(queryClient, entity, state.field);
  if (!field) return null;
  const raw = readField(record, field);
  if (typeof raw !== "string") return null;
  const option = optionOf(field, raw);
  const valueOf = (key: string) => {
    const declared = fieldOf(queryClient, entity, key);
    return declared ? readField(record, declared) : undefined;
  };
  const text = (key: string | undefined) => {
    if (key === undefined) return null;
    const value = valueOf(key);
    return typeof value === "string" && value !== "" ? value : null;
  };
  const wait =
    state.wait === undefined
      ? undefined
      : runWaitingOn.safeParse(valueOf(state.wait));
  return {
    option: { label: option?.label ?? raw, stage: optionStage(option) },
    phase: option ? optionPhase(option) : "active",
    reason: text(state.reason),
    wait: wait?.success ? wait.data : undefined,
    stalled: state.stalled !== undefined && valueOf(state.stalled) === true,
    failed: optionStage(option) === "stuck",
  };
}

/** The record's kind from `presentation.kind`: its option. */
export interface RecordKind {
  label: string;
  description?: string;
  glyph?: { phosphor: string };
}

export function recordKindOf<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
): RecordKind | null {
  const { kind }: CompiledEntityPresentation = entityMetadata(
    queryClient,
    entity,
  ).summary;
  if (kind === null) return null;
  const field = fieldOf(queryClient, entity, kind.field);
  if (!field) return null;
  const raw = readField(record, field);
  const option = optionOf(field, raw);
  if (typeof raw !== "string") return null;
  return {
    label: option?.label ?? raw,
    description:
      option &&
      "description" in option &&
      typeof option.description === "string"
        ? option.description
        : undefined,
    glyph: option && "glyph" in option ? option.glyph : undefined,
  };
}

/** A line's value: a linked display item, plain text, or the field's renderer. */
function lineValue<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
  field: Field,
): ReactNode {
  const raw = readField(record, field);
  if (raw === null || raw === undefined || raw === "")
    return <NotRecordedValue />;
  if (typeof raw === "string") return raw;
  const item = displayItem.safeParse(raw);
  if (item.success) {
    const target = entitySchema.safeParse(item.data.entity);
    return target.success &&
      item.data.id &&
      isBrowserRoutedEntity(target.data) ? (
      <Link
        to={entities[target.data].routes.detail}
        params={entityDetailParams(item.data.id)}
        className="text-link hover:underline"
      >
        {item.data.title}
      </Link>
    ) : (
      item.data.title
    );
  }
  return renderDetailFieldValue(queryClient, entity, record, field);
}

/**
 * The declared `detail.lines`, each label with its drawn value. A number
 * field's line is a figure: lines carrying figures draw as key facts. A line
 * with nothing recorded is left out; the header never prints "Not recorded".
 */
export function headerLinesOf<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
): { label: string; value: ReactNode; figure: boolean }[] {
  const { detail }: CompiledEntityPresentation = entityMetadata(
    queryClient,
    entity,
  ).summary;
  return detail.lines.flatMap((line) => {
    const field = fieldOf(queryClient, entity, line.field);
    const raw = field ? readField(record, field) : undefined;
    return field && raw !== null && raw !== undefined && raw !== ""
      ? [
          {
            label: line.label,
            value: lineValue(queryClient, entity, record, field),
            figure: field.kind === "number",
          },
        ]
      : [];
  });
}

const storedSummary = z.object({
  text: z.string().min(1),
  model: z.string().min(1),
  writtenAt: z.string().optional(),
});

/** The stored AI summary `detail.aiSummary` names, when the record has one. */
export function aiSummaryOf<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
): z.infer<typeof storedSummary> | null {
  const { detail }: CompiledEntityPresentation = entityMetadata(
    queryClient,
    entity,
  ).summary;
  const key = detail.aiSummary;
  if (key === null) return null;
  const field = fieldOf(queryClient, entity, key);
  const parsed = storedSummary.safeParse(
    field ? readField(record, field) : undefined,
  );
  return parsed.success ? parsed.data : null;
}

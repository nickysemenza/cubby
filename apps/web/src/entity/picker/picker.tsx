import { entityRoster } from "@cubby/schemas/entity-roster";

import { entityLabel } from "~/entity/entities";
import { detailEntities } from "~/entity/generated/entity-details.gen";
import { listEntities } from "~/entity/generated/entity-lists.gen";
import type { PickerEntity } from "~/ui/combobox/combobox-types";
import {
  Picker as ValuePicker,
  type PickerProps as ValuePickerProps,
  type PickerRecordSource,
  type RecordPickerProps as ValueRecordPickerProps,
} from "~/ui/combobox/picker";

import { useSelectedPickerItems } from "./selected-items";

type WithEntity<P> = P extends unknown
  ? Omit<P, "records"> & { entity?: PickerEntity }
  : never;

export type PickerProps<TId extends string = string> = WithEntity<
  ValuePickerProps<TId>
>;

/** A record-valued single picker's props — what wrappers that own the
 * roster (search providers, reference pickers) extend. */
export type RecordPickerProps<TId extends string = string> = WithEntity<
  ValueRecordPickerProps<TId>
>;

const pickerEntities = new Set<string>(
  listEntities.filter((entity) =>
    detailEntities.some((candidate) => candidate === entity),
  ),
);

/** Whether a reference target can be picked as records (has a list and a detail read). */
export const isPickerEntity = (entity: string): entity is PickerEntity =>
  pickerEntities.has(entity);

const sources = new Map<PickerEntity, PickerRecordSource>();

/** An entity's record source: its noun, its shortcode prefix, and selected-code resolution. */
export function recordSource(entity: PickerEntity): PickerRecordSource {
  const known = sources.get(entity);
  if (known) return known;
  const source: PickerRecordSource = {
    noun: entityLabel(entity),
    codeType: entity,
    codePrefix: entityRoster[entity].shortcodePrefix,
    useSelectedItems: (ids, held) => useSelectedPickerItems(entity, ids, held),
  };
  sources.set(entity, source);
  return source;
}

/**
 * The value picker over an entity's records: `entity` names the placeholder
 * and create strings, checks typed codes against the entity's prefix, and
 * resolves selected codes to their records.
 */
export function Picker<TId extends string = string>({
  entity,
  ...props
}: PickerProps<TId>) {
  // SAFETY: removing `entity` from one `PickerProps` variant leaves that same
  // `ValuePickerProps` variant without `records`, which is supplied here.
  const valueProps = props as ValuePickerProps<TId>;
  return (
    <ValuePicker
      {...valueProps}
      records={entity ? recordSource(entity) : undefined}
    />
  );
}

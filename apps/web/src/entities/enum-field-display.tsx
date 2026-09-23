import type { Entity } from "@cubby/schemas/entity";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";

import {
  fieldSuggestionBasisFromRecord,
  suggestTargetsFor,
  type FieldSuggestionSource,
} from "~/app/_components/ai/field-suggestion";
import type { ScalarDisplayValue } from "~/components/common/scalar-value";

import {
  presentEntitySelectOptions,
  type EntitySelectOption,
} from "./editing/select-options";

type EnumField = Pick<EntityFieldModel["fields"][number], "key" | "control">;

/** A stored value the roster never declared still needs a tint. */
const UNKNOWN_ENUM_COLOR = "var(--slate)";

const optionsCache = new Map<string, EntitySelectOption[]>();

/**
 * The one option roster every enum surface reads — list cell, detail value,
 * hero chip, inline editor, previews. Declared `control.options` merged with
 * the rich `ENTITY_SELECT_OPTIONS` table, colorized; `"edit"` mode drops
 * create-only sentinels (`expense.lineKind`'s `"auto"`) because a stored
 * value is never one. Cached per field: manifests are static.
 */
export function enumFieldOptions(
  entity: Entity,
  field: EnumField,
): EntitySelectOption[] {
  const cacheKey = `${entity}.${field.key}`;
  const cached = optionsCache.get(cacheKey);
  if (cached) return cached;
  const options = presentEntitySelectOptions(
    entity,
    field.key,
    field.control?.options ?? [],
    "edit",
  );
  optionsCache.set(cacheKey, options);
  return options;
}

function enumFieldOption(
  entity: Entity,
  field: EnumField,
  raw: string,
): EntitySelectOption | undefined {
  return enumFieldOptions(entity, field).find((option) => option.value === raw);
}

/**
 * The display value a stored enum reads as: its roster presentation, or the
 * value itself in the unknown tint when the roster forgot it — hiding a real
 * stored value behind "—" is how it would stay forgotten.
 */
export function enumDisplayValue(
  entity: Entity,
  field: EnumField,
  raw: string,
): Extract<ScalarDisplayValue, { kind: "enum" }> {
  const option = enumFieldOption(entity, field, raw);
  return {
    kind: "enum",
    raw,
    label: option?.label ?? raw,
    color: option?.color ?? UNKNOWN_ENUM_COLOR,
    icon: option?.icon,
    description: option?.description,
  };
}

/**
 * The rich label for a stored enum value, or the value itself when the
 * roster forgot it — hiding a real stored value behind "—" is how it would
 * stay forgotten. For prose surfaces (previews, search rows, hero chip).
 */
export function enumFieldLabel(
  entity: Entity,
  key: string,
  raw: string | null | undefined,
): string | null {
  if (raw == null || raw === "") return null;
  const field = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === key,
  );
  if (!field) return raw;
  return enumFieldOption(entity, field, raw)?.label ?? raw;
}

/**
 * The editor-level Jev source for a field that declares `control.suggest`:
 * always `"provided"` so the apply affordance works whether or not a value is
 * already stored. Shared by the generic list editor and the detail editor so
 * neither surface forgets it.
 */
export function enumFieldSuggestSource<TRecord extends object>(
  entity: Entity,
  field: EnumField,
  record: TRecord,
): FieldSuggestionSource | undefined {
  if (!field.control?.suggest) return undefined;
  // SAFETY: only a shortcode entity reaches an editable surface; `Entity` is
  // the wider display-field plumbing type.
  const shortcodeEntity = entity as ShortcodeEntity;
  return {
    basisMode: "provided",
    entity: shortcodeEntity,
    targets: [field.key],
    basis: fieldSuggestionBasisFromRecord(
      shortcodeEntity,
      suggestTargetsFor(shortcodeEntity, [field.key]),
      record,
    ),
  };
}

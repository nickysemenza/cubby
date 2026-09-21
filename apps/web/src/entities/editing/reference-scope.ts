import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { z } from "zod";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import type { EntitySearchScope } from "~/app/_components/combobox/entity-search-hooks";

import type { EntityEditValue, EntityEditValueBag } from "./value-schema";

type ReferenceWithScope = NonNullable<
  EntityFieldModel["fields"][number]["reference"]
>;

/** Keep every selected id represented when a dependent scope changes. */
export function preserveSelectedPickerItems<TId extends string>(
  items: readonly ComboboxItem<TId>[],
  selectedIds: readonly TId[],
): ComboboxItem<TId>[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return selectedIds.map((id) => byId.get(id) ?? { id, name: id });
}

const scopeValueSchema = z.union([z.string(), z.array(z.string())]);

const stringValue = (value: EntityEditValue): string | string[] | null => {
  const parsed = scopeValueSchema.safeParse(value);
  if (!parsed.success) return null;
  if (!Array.isArray(parsed.data)) return parsed.data.trim() || null;
  const values = parsed.data.map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? values : null;
};

/**
 * Resolve a manifest reference's dependent candidate filters from the current
 * editor values. `undefined` means no scope was declared; `null` means the
 * declared scope is incomplete and the picker must remain empty.
 */
export function referenceScopeFor(
  reference: ReferenceWithScope | null | undefined,
  values: EntityEditValueBag,
): EntitySearchScope | null | undefined {
  const mappings = reference?.scope ?? [];
  const fixed = reference?.filters ?? [];
  if (mappings.length === 0 && fixed.length === 0) return undefined;
  const filters: Record<string, string | readonly string[]> = {};
  for (const filter of fixed) filters[filter.field] = filter.values;
  for (const mapping of mappings) {
    const value = stringValue(values[mapping.sourceField]);
    if (value === null) return null;
    const allowed = filters[mapping.targetField];
    if (allowed !== undefined) {
      const permitted = new Set(Array.isArray(allowed) ? allowed : [allowed]);
      const candidates = Array.isArray(value) ? value : [value];
      const intersection = candidates.filter((candidate) =>
        permitted.has(candidate),
      );
      if (intersection.length === 0) return null;
      filters[mapping.targetField] = intersection;
    } else filters[mapping.targetField] = value;
  }
  return filters;
}

export function referenceScopeFields(
  reference: ReferenceWithScope | null | undefined,
): string[] {
  return reference?.scope.map((mapping) => mapping.sourceField) ?? [];
}

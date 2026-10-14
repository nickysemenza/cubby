import type { Entity } from "@cubby/schemas/entity";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { z } from "zod";

import { formatCount, formatCurrency } from "~/lib/utils";

import { readDisplayReferenceField } from "./entity-references";
import { enumFieldLabel } from "./enum-field-display";
import { readPathValue } from "./read-path";

type DisplayField = EntityFieldModel["fields"][number];

const scalar = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

/** Money is declared either as a currency display format or as the money
 * number control (`renderer: "money"`, e.g. a project's cost estimate). */
const isMoneyField = (field: DisplayField) =>
  field.display.format === "currency" ||
  field.display.format === "signedCurrency" ||
  (field.control !== null &&
    "renderer" in field.control &&
    field.control.renderer === "money");

/**
 * A field's value as short plain text for dense, non-interactive surfaces
 * (picker rows and chips, accessible names): references read as their names,
 * never codes; numbers follow the declared format; enums use their label.
 * A leaf on purpose — the picker builders read it without importing entity
 * display, which imports the picker stack.
 */
export function compactFieldText<TRecord extends object>(
  entity: Entity,
  record: TRecord,
  field: DisplayField,
): string | null {
  const reference = readDisplayReferenceField(record, field);
  if (reference !== null) {
    const names = reference.items.flatMap((item) =>
      item.name ? [item.name] : [],
    );
    return names.length > 0 ? names.join(", ") : null;
  }
  const path = field.display.readPath ?? field.readKey;
  const raw = path ? readPathValue(record, path) : undefined;
  const value = scalar.safeParse(raw).data;
  if (value === undefined || value === "") return null;
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number")
    return isMoneyField(field) ? formatCurrency(value) : formatCount(value, 2);
  if (field.kind === "enum") return enumFieldLabel(entity, field.key, value);
  if (field.kind === "timestamp") return new Date(value).toLocaleDateString();
  // A plain identifier field is a code; only its reference names display.
  if (field.kind === "identifier") return null;
  return value;
}

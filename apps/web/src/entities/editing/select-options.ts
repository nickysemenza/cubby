import type { ReactNode } from "react";

import { locationTypeOptionsWithTheme } from "~/app/_components/locations/location-icons";
import { productCategoryOptionsWithTheme } from "~/app/_components/products/product-category-icons";
import {
  costTypeOptions,
  expenseLineKindOptions,
} from "~/app/expenses/expense-options";
import { mealKindOptions, mealTypeOptions } from "~/app/meals/meal-options";
import {
  PROJECT_STATUS_OPTIONS,
  projectKindOptions,
} from "~/app/projects/project-options";
import { tradeOptions } from "~/app/projects/trade-options";
import { taskStatusOptions } from "~/app/tasks/task-options";

/** One `<select>`/combobox option: a value/label pair plus an optional leading icon or swatch color. */
export type EntitySelectOption = Readonly<{
  value: string;
  label: string;
  icon?: ReactNode;
  color?: string;
}>;

/**
 * Option labels for every `entity.field` whose manifest `control` carries no
 * `options` of its own — an enum backed by a themed/colored/iconed option set
 * rather than the plain `{value,label}` pairs `control.options` already
 * declares. Consolidates what were two separately maintained tables
 * (`richSelectOptions` in `entity-primitive-fields.tsx`, `bulkEditSelectOptions`
 * in `bulk-edit-entity-action.tsx`) into one, so the generic editor
 * (`EntityIntentFields`/`EntityPrimitiveFields`), bulk edit, and detail-page
 * inline `select` editors (`entity-display.tsx`) all read the same source —
 * see `docs/entities.md`'s `control.suggest` section for why a select field's
 * options and its auto-suggest hint must agree.
 */
const ENTITY_SELECT_OPTIONS = {
  "task.status": taskStatusOptions,
  "task.trade": tradeOptions,
  "project.status": PROJECT_STATUS_OPTIONS,
  "project.kind": projectKindOptions,
  "meal.mealType": mealTypeOptions,
  "meal.mealKind": mealKindOptions,
  "expense.trade": tradeOptions,
  "expense.costType": costTypeOptions,
  // The capture form's `"auto"` sentinel: `lineKind` is left undecided on
  // create and derived server-side from the name — `buildData` strips it
  // before validation (`entities/editing/definitions.ts`).
  "expense.lineKind": [
    { value: "auto", label: "Auto-detect from name" },
    ...expenseLineKindOptions,
  ],
  "product.category": productCategoryOptionsWithTheme,
  "location.type": locationTypeOptionsWithTheme,
} satisfies Readonly<Record<string, readonly EntitySelectOption[]>>;

/**
 * `mode` filters out create-only sentinel options (`"expense.lineKind"`'s
 * `"auto"`) once the field is editing a stored record: the update schema
 * has no `"auto"` member, so an edit surface offering it would let a
 * submit fail validation on a value the create-only `buildData` strip
 * never sees.
 */
export function entitySelectOptionsFor(
  entity: string,
  key: string,
  mode?: "create" | "edit",
): readonly EntitySelectOption[] | undefined {
  const optionsKey = `${entity}.${key}`;
  if (!Object.hasOwn(ENTITY_SELECT_OPTIONS, optionsKey)) return undefined;
  // SAFETY: the `Object.hasOwn` check above proves `optionsKey` is one of
  // `ENTITY_SELECT_OPTIONS`'s own declared keys, not an arbitrary string.
  const options =
    ENTITY_SELECT_OPTIONS[optionsKey as keyof typeof ENTITY_SELECT_OPTIONS];
  if (optionsKey === "expense.lineKind" && mode === "edit") {
    return options.filter((option) => option.value !== "auto");
  }
  return options;
}

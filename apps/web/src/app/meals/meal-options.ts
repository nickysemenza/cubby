import {
  MEAL_KIND_LABELS,
  MEAL_TYPE_LABELS,
  type MealKind,
  mealKindValues,
  mealTypeValues,
} from "@cubby/schemas/meal-classification";
import type { BadgeVariant } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { buildSelectOptions } from "~/lib/select-options";

/**
 * Presentation for the two meal classification enums.
 *
 * A leaf module on purpose: `filter-manifest.tsx` imports these option lists,
 * and the manifest is itself reached from `useStandardColumns`. Putting them
 * in `meal-table.tsx` would close that loop (same reason `trade-options.tsx`
 * sits apart from `projects/shared.tsx`). Labels live in `@cubby/schemas` so
 * the server can name a slot too; only the chip tones are client-side.
 */
export const mealTypeOptions: FilterableComboboxItem[] = buildSelectOptions(
  mealTypeValues,
  MEAL_TYPE_LABELS,
);

export const mealKindOptions: FilterableComboboxItem[] = buildSelectOptions(
  mealKindValues,
  MEAL_KIND_LABELS,
);

/**
 * Chip tone per kind. `cooked` is the overwhelming majority and the default,
 * so it stays neutral — tone is spent on the exceptions, which is the whole
 * point of scanning this column. The eat-out kinds share the ultramarine
 * accent (money left the house), leftovers reads as a reuse, and `other` is
 * the quiet outline.
 */
export const mealKindBadgeVariant: Record<MealKind, BadgeVariant> = {
  cooked: "secondary",
  leftovers: "slate",
  eating_out: "default",
  takeout: "default",
  other: "outline",
};

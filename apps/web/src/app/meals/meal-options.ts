import {
  MEAL_KIND_LABELS,
  MEAL_TYPE_LABELS,
  MEAL_TYPE_START_MINUTES,
  type MealKind,
  type MealType,
  mealKindValues,
  mealTypeValues,
} from "@cubby/schemas/meal-classification";
import { format } from "date-fns";
import {
  CircleDashed,
  Cookie,
  CookingPot,
  Croissant,
  IceCreamCone,
  type LucideIcon,
  Moon,
  Refrigerator,
  ShoppingBag,
  Sun,
  Sunrise,
  UtensilsCrossed,
} from "lucide-react";
import { type BadgeVariant, badgeVariantColor } from "~/components/ui/badge";
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

/**
 * Tone per kind. `cooked` is the overwhelming majority and the default, so it
 * stays neutral — tone is spent on the exceptions, which is the whole point of
 * scanning this column. The eat-out kinds share the ultramarine accent (money
 * left the house), leftovers reads as a reuse, and `other` is the quiet
 * outline.
 */
export const mealKindBadgeVariant: Record<MealKind, BadgeVariant> = {
  cooked: "secondary",
  leftovers: "slate",
  eating_out: "default",
  takeout: "default",
  other: "outline",
};

/** Declared after the tone map so the roster can carry it as the dot ink — the
 *  table cell renders label + colour straight off these options. */
export const mealKindOptions: FilterableComboboxItem[] = mealKindValues.map(
  (value) => ({
    value,
    label: MEAL_KIND_LABELS[value],
    color: badgeVariantColor[mealKindBadgeVariant[value]],
  }),
);

/**
 * Clock label for a slot — "9:00 AM" — or null when the meal is unslotted.
 *
 * Reads off `MEAL_TYPE_START_MINUTES`, the same map the published ICS feed
 * places events with, so the app and a subscribed calendar never disagree about
 * when dinner is. `h:mm a` matches the calendar's own `eventTime` format.
 *
 * The epoch date is arbitrary scaffolding for the formatter: only the
 * hour/minute fields are rendered, and constructing it locally keeps the label
 * a pure function of the slot.
 */
export function mealTypeTimeLabel(type: MealType | null): string | null {
  if (!type) return null;
  const minutes = MEAL_TYPE_START_MINUTES[type];
  return format(
    new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60),
    "h:mm a",
  );
}

/**
 * Slot glyphs for tight surfaces — the calendar chip, where the label is
 * either already the title or has no room. Breakfast/lunch/dinner take the
 * time-of-day triad because they *are* the day's anchors; the three minor
 * slots take food glyphs. Monochrome Lucide on `currentColor`, never emoji
 * (same rule as `TRADE_ICONS`).
 */
const MEAL_TYPE_ICONS: Record<MealType, LucideIcon> = {
  breakfast: Sunrise,
  brunch: Croissant,
  lunch: Sun,
  dinner: Moon,
  snack: Cookie,
  dessert: IceCreamCone,
};

/** What an unslotted meal shows — the generic glyph the calendar used for all meals. */
const UNSLOTTED_MEAL_ICON: LucideIcon = CookingPot;

/**
 * Kind glyphs, and `cooked` is deliberately absent.
 *
 * Nearly every meal is cooked, so marking it would put a glyph on everything
 * and distinguish nothing — the marker only earns its place on the exception.
 * Same rule as `mealKindBadgeVariant`'s neutral `cooked` tone and the ICS
 * description, which likewise names the kind only when it isn't `cooked`.
 */
const MEAL_KIND_ICONS: Record<Exclude<MealKind, "cooked">, LucideIcon> = {
  leftovers: Refrigerator,
  eating_out: UtensilsCrossed,
  takeout: ShoppingBag,
  other: CircleDashed,
};

/** The slot glyph, or the generic pot when unslotted. */
export const mealTypeIcon = (mealType: MealType | null): LucideIcon =>
  mealType ? MEAL_TYPE_ICONS[mealType] : UNSLOTTED_MEAL_ICON;

/** The kind glyph, or null for `cooked` — see `MEAL_KIND_ICONS`. */
export const mealKindIcon = (mealKind: MealKind): LucideIcon | null =>
  mealKind === "cooked" ? null : MEAL_KIND_ICONS[mealKind];

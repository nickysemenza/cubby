import {
  MEAL_TYPE_START_MINUTES,
  type MealKind,
  type MealType,
} from "@cubby/schemas/meal-classification";
import { BreadIcon } from "@phosphor-icons/react/dist/csr/Bread";
import { CircleDashedIcon } from "@phosphor-icons/react/dist/csr/CircleDashed";
import { CookieIcon } from "@phosphor-icons/react/dist/csr/Cookie";
import { CookingPotIcon } from "@phosphor-icons/react/dist/csr/CookingPot";
import { ForkKnifeIcon } from "@phosphor-icons/react/dist/csr/ForkKnife";
import { IceCreamIcon } from "@phosphor-icons/react/dist/csr/IceCream";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { RepeatIcon } from "@phosphor-icons/react/dist/csr/Repeat";
import { ShoppingBagIcon } from "@phosphor-icons/react/dist/csr/ShoppingBag";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { SunHorizonIcon } from "@phosphor-icons/react/dist/csr/SunHorizon";
import type { Icon } from "@phosphor-icons/react/lib";
import { format } from "date-fns";

import { type BadgeVariant } from "~/components/ui/badge";

/**
 * Presentation for the two meal classification enums.
 *
 * A leaf module on purpose: `filter-manifest.tsx` imports these option lists,
 * and the manifest is itself reached from `useStandardColumns`. Putting them
 * in `meal-table.tsx` would close that loop (same reason `trade-options.tsx`
 * sits apart from `projects/shared.tsx`). Labels live in `@cubby/schemas` so
 * the server can name a slot too; only the chip tones are client-side.
 */
/**
 * Tone per kind. `cooked` is the overwhelming majority and the default, so it
 * stays neutral — tone is spent on the exceptions, which is the whole point of
 * scanning this column. The eat-out kinds share the ultramarine accent (money
 * left the house), leftovers reads as a reuse, and `other` is the quiet
 * outline.
 */
export const mealKindBadgeVariant = {
  cooked: "secondary",
  leftovers: "slate",
  eating_out: "default",
  takeout: "default",
  other: "outline",
} satisfies Record<MealKind, BadgeVariant>;

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
 * slots take food glyphs. Monochrome Phosphor on `currentColor`, never emoji
 * (same rule as `TRADE_ICONS`).
 */
const MEAL_TYPE_ICONS = {
  breakfast: SunHorizonIcon,
  brunch: BreadIcon,
  lunch: SunIcon,
  dinner: MoonIcon,
  snack: CookieIcon,
  dessert: IceCreamIcon,
} satisfies Record<MealType, Icon>;

/** What an unslotted meal shows — the generic glyph the calendar used for all meals. */
const UNSLOTTED_MEAL_ICON: Icon = CookingPotIcon;

/**
 * Kind glyphs, and `cooked` is deliberately absent.
 *
 * Nearly every meal is cooked, so marking it would put a glyph on everything
 * and distinguish nothing — the marker only earns its place on the exception.
 * Same rule as `mealKindBadgeVariant`'s neutral `cooked` tone and the ICS
 * description, which likewise names the kind only when it isn't `cooked`.
 */
const MEAL_KIND_ICONS = {
  leftovers: RepeatIcon,
  eating_out: ForkKnifeIcon,
  takeout: ShoppingBagIcon,
  other: CircleDashedIcon,
} satisfies Record<Exclude<MealKind, "cooked">, Icon>;

/** The slot glyph, or the generic pot when unslotted. */
export const mealTypeIcon = (mealType: MealType | null): Icon =>
  mealType ? MEAL_TYPE_ICONS[mealType] : UNSLOTTED_MEAL_ICON;

/** The kind glyph, or null for `cooked` — see `MEAL_KIND_ICONS`. */
export const mealKindIcon = (mealKind: MealKind): Icon | null =>
  mealKind === "cooked" ? null : MEAL_KIND_ICONS[mealKind];

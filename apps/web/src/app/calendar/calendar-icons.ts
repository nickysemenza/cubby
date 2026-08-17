import type { CalendarItem, CalendarItemKind } from "@cubby/schemas/calendar";
import {
  CalendarRange,
  CheckSquare,
  CircleDollarSign,
  CookingPot,
  type LucideIcon,
} from "lucide-react";
import { mealTypeIcon } from "~/app/meals/meal-options";

/**
 * The kind→glyph map, in a LEAF module.
 *
 * It lives apart from `calendar-item-row` because the filter manifest needs it
 * too, and that row component pulls in `entityDetailLink` and the router — a
 * graph the specs (and their unit test) have no business loading. Same reason
 * `tradeOptions` sits in its own module rather than in `app/projects/shared`.
 */
export const KIND_ICONS: Record<CalendarItemKind, LucideIcon> = {
  meal: CookingPot,
  task: CheckSquare,
  expense: CircleDollarSign,
  project: CalendarRange,
};

/**
 * The leading glyph. Meals resolve to their slot (breakfast → dinner) rather
 * than the generic per-kind pot: the slot is the meal's primary
 * classification, it already orders the day, and the icon costs no width the
 * title could have used.
 */
export const itemIcon = (item: CalendarItem): LucideIcon =>
  item.kind === "meal" ? mealTypeIcon(item.mealType) : KIND_ICONS[item.kind];

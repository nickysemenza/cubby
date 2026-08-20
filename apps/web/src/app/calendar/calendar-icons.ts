import type { CalendarItemKind } from "@cubby/schemas/calendar";
import {
  CalendarRange,
  CheckSquare,
  CircleDollarSign,
  CookingPot,
  type LucideIcon,
} from "lucide-react";

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

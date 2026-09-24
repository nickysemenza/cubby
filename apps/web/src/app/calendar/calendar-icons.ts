import type { CalendarItemKind } from "@cubby/schemas/calendar";
import { CalendarBlankIcon as CalendarRange } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { CheckSquareIcon as CheckSquare } from "@phosphor-icons/react/dist/csr/CheckSquare";
import { CookingPotIcon as CookingPot } from "@phosphor-icons/react/dist/csr/CookingPot";
import { CurrencyCircleDollarIcon as CircleDollarSign } from "@phosphor-icons/react/dist/csr/CurrencyCircleDollar";
import { PlantIcon as Sprout } from "@phosphor-icons/react/dist/csr/Plant";
import type { Icon } from "@phosphor-icons/react/lib";

/**
 * The kind→glyph map, in a LEAF module.
 *
 * It lives apart from `calendar-item-row` because the filter manifest needs it
 * too, and that row component pulls in `entityDetailLink` and the router — a
 * graph the specs (and their unit test) have no business loading. Same reason
 * `tradeOptions` sits in its own module rather than in `app/projects/shared`.
 */
export const KIND_ICONS = {
  meal: CookingPot,
  task: CheckSquare,
  expense: CircleDollarSign,
  project: CalendarRange,
  planting: Sprout,
} satisfies Record<CalendarItemKind, Icon>;

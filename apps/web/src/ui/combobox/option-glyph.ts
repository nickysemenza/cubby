import { CalendarDotsIcon } from "@phosphor-icons/react/dist/csr/CalendarDots";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleDashedIcon } from "@phosphor-icons/react/dist/csr/CircleDashed";
import { CircleHalfIcon } from "@phosphor-icons/react/dist/csr/CircleHalf";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { HourglassIcon } from "@phosphor-icons/react/dist/csr/Hourglass";
import { PauseCircleIcon } from "@phosphor-icons/react/dist/csr/PauseCircle";
import { ProhibitIcon } from "@phosphor-icons/react/dist/csr/Prohibit";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import type { Icon } from "@phosphor-icons/react/lib";

/**
 * The Phosphor components an option `glyph` names. Covers the shared enum
 * palette's inferred status glyphs (`@cubby/shared` enum-palette); a
 * declared glyph outside this set falls back to the option's tone dot.
 */
const OPTION_GLYPHS = {
  CalendarDots: CalendarDotsIcon,
  CheckCircle: CheckCircleIcon,
  CircleDashed: CircleDashedIcon,
  CircleHalf: CircleHalfIcon,
  Clock: ClockIcon,
  Hourglass: HourglassIcon,
  PauseCircle: PauseCircleIcon,
  Prohibit: ProhibitIcon,
  XCircle: XCircleIcon,
} satisfies Readonly<Record<string, Icon>>;

export const optionGlyphIcon = (name: string): Icon | undefined =>
  isOptionGlyph(name) ? OPTION_GLYPHS[name] : undefined;

const isOptionGlyph = (name: string): name is keyof typeof OPTION_GLYPHS =>
  Object.hasOwn(OPTION_GLYPHS, name);

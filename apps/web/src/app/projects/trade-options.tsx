import { type Trade, tradeValues } from "@cubby/schemas/project";
import {
  Archive,
  Car,
  ClipboardList,
  Droplets,
  Fan,
  Grid3x3,
  Hammer,
  type LucideIcon,
  PaintRoller,
  Palette,
  RectangleHorizontal,
  Refrigerator,
  Ruler,
  Shapes as OtherTradeIcon,
  Square,
  Trash2,
  Trees,
  Truck,
  Wrench,
  Zap,
} from "lucide-react";

import { Badge } from "~/components/ui/badge";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

import { TRADE_LABELS } from "./project-formatting";

/**
 * Trade presentation — glyphs, chips, and select options.
 *
 * Split out of `shared.tsx` so the filter manifest can import `tradeOptions`
 * without dragging in the tables `shared.tsx` defines. Those tables reach the
 * manifest through `useStandardColumns`, so importing them back would close an
 * import cycle and leave these module-level consts `undefined` at first
 * evaluation. `shared.tsx` re-exports everything here, so its consumers are
 * unaffected.
 */

/**
 * Monochrome Lucide glyph per trade — a scannable leading mark for badges and
 * select rows. Icons live here (client) rather than in `@cubby/schemas` so the
 * schema package stays presentation-free. Full-color emoji were deliberately
 * dropped in the Notion migration; these `currentColor` glyphs sit cleanly on
 * Porcelain surfaces without a glossy clash.
 */
const TRADE_ICONS = {
  planning: ClipboardList,
  demolition: Trash2,
  building: Hammer,
  drywall: Square,
  electrical: Zap,
  plumbing: Droplets,
  mechanical: Fan,
  cabinetry: Archive,
  countertop: RectangleHorizontal,
  flooring: Grid3x3,
  millwork: Ruler,
  finishes: PaintRoller,
  appliances: Refrigerator,
  landscaping: Trees,
  logistics: Truck,
  metalworking: Wrench,
  crafts: Palette,
  auto: Car,
  other: OtherTradeIcon,
} satisfies Record<Trade, LucideIcon>;

/** Outline badge with the trade's leading glyph + label — the canonical trade chip. */
export function TradeBadge({ trade }: { trade: Trade }) {
  const Icon = TRADE_ICONS[trade];
  return (
    <Badge variant="outline">
      <Icon />
      {TRADE_LABELS[trade]}
    </Badge>
  );
}

/**
 * Bare trade glyph — the same icon as `TradeBadge` without the pill, for tight
 * spots like the Gantt name pane where the label is already present.
 */
export function TradeIcon({
  trade,
  className,
}: {
  trade: Trade;
  className?: string;
}) {
  const Icon = TRADE_ICONS[trade];
  return <Icon className={className} aria-label={TRADE_LABELS[trade]} />;
}

/**
 * `{value,label,icon}` options for the trade filter/inline-edit select — shared
 * by tasks and expenses. Not `buildSelectOptions` because that helper carries
 * no icon; the glyph mirrors `TradeBadge` so the select and the chip match.
 */
export const tradeOptions: FilterableComboboxItem[] = tradeValues.map(
  (value) => {
    const Icon = TRADE_ICONS[value];
    return {
      value,
      label: TRADE_LABELS[value],
      icon: <Icon className="size-3.5" />,
    };
  },
);

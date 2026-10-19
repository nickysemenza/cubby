import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { type Trade, TRADE_LABELS } from "@cubby/schemas/project";

import type { PickerOption } from "~/ui/combobox/picker-option";
import { OptionGlyph } from "~/ui/common/option-glyph";

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
 * Monochrome glyph per trade, from the trade declaration's option `glyph` so
 * web and Apple draw the same mark. `currentColor` glyphs sit cleanly on the
 * neutral category chip.
 */
const tradeRoster =
  entityFieldModels.task.fields.find((field) => field.key === "trade")?.control
    ?.options ?? [];
const TRADE_GLYPHS = new Map(
  tradeRoster.map((option) => [option.value, option.glyph?.phosphor]),
);

/**
 * Bare trade glyph — the same icon as `TradeBadge` without the pill, for tight
 * spots like a schedule name pane where the label is already present.
 */
export function TradeIcon({
  trade,
  className,
}: {
  trade: Trade;
  className?: string;
}) {
  return (
    <OptionGlyph
      name={TRADE_GLYPHS.get(trade) ?? "Shapes"}
      weight="regular"
      className={className}
      label={TRADE_LABELS[trade]}
    />
  );
}

/**
 * `{value,label,icon}` options for the trade filter/inline-edit select — shared
 * by tasks and expenses. The glyph mirrors `TradeBadge` so the select and the
 * chip match.
 */
export const tradeOptions: PickerOption[] = tradeRoster.map((option) => ({
  value: option.value,
  label: option.label,
  icon: (
    <OptionGlyph
      name={option.glyph?.phosphor ?? "Shapes"}
      weight="regular"
      className="size-3.5"
    />
  ),
}));

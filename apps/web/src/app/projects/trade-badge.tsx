import type { Trade } from "@cubby/schemas/project";

import { fieldEnumOptions } from "~/entity/enum-field-display";
import { EnumPill } from "~/ui/primitives/enum-pill";

import { TRADE_LABELS } from "./project-formatting";
import { TradeIcon } from "./trade-options";

// Separate from the options module: the enum registry imports that module during initialization.
export function TradeBadge({ trade }: { trade: Trade }) {
  const option = fieldEnumOptions("task", "trade").find(
    (option) => option.value === trade,
  );
  return (
    <EnumPill color={option?.color} icon={<TradeIcon trade={trade} />}>
      {option?.label ?? TRADE_LABELS[trade]}
    </EnumPill>
  );
}

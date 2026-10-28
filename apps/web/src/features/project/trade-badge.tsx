import { TRADE_LABELS, type Trade } from "@cubby/schemas/task-fields";
import { useQueryClient } from "@tanstack/react-query";

import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { useEntityMetadata } from "~/entity/metadata";
import { EnumPill } from "~/ui/primitives/enum-pill";

import { TradeIcon } from "../../entity/presentation/trade-options";

export function TradeBadge({ trade }: { trade: Trade }) {
  const queryClient = useQueryClient();
  useEntityMetadata("task");
  const option = fieldEnumOptions(queryClient, "task", "trade").find(
    (option) => option.value === trade,
  );
  return (
    <EnumPill
      optionRole={option?.role}
      color={option?.color}
      icon={<TradeIcon trade={trade} />}
    >
      {option?.label ?? TRADE_LABELS[trade]}
    </EnumPill>
  );
}

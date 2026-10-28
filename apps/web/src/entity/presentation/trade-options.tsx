import { type Trade, TRADE_LABELS } from "@cubby/schemas/task-fields";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { entityMetadata, useEntityMetadata } from "~/entity/metadata";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { OptionGlyph } from "~/ui/common/option-glyph";

/** Trade glyphs and choices share the canonical declaration's scoped roster. */
function tradeRoster(queryClient: QueryClient) {
  return (
    entityMetadata(queryClient, "task").fields.fields.find(
      (field) => field.key === "trade",
    )?.control?.options ?? []
  );
}

export function TradeIcon({
  trade,
  className,
}: {
  trade: Trade;
  className?: string;
}) {
  const queryClient = useQueryClient();
  useEntityMetadata("task");
  const option = tradeRoster(queryClient).find(
    (candidate) => candidate.value === trade,
  );
  return (
    <OptionGlyph
      name={option?.glyph?.phosphor ?? "Shapes"}
      weight="regular"
      className={className}
      label={TRADE_LABELS[trade]}
    />
  );
}

export function tradeOptions(queryClient: QueryClient): PickerOption[] {
  return tradeRoster(queryClient).map((option) => ({
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
}

export function useTradeOptions(): PickerOption[] {
  const queryClient = useQueryClient();
  useEntityMetadata("task");
  return useMemo(() => tradeOptions(queryClient), [queryClient]);
}

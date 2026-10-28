import { historicalDateRangePresets } from "@cubby/schemas/date-range";

import { resolveDateRange } from "~/lib/date-range-presets";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

/** Viewing windows use historical shortcuts; stored deadline dates keep their own semantics. */
export function DateRangeShortcuts({
  onSelect,
  disabled = false,
  allLabel = "All time",
}: {
  onSelect: (bounds: ReturnType<typeof resolveDateRange>) => void;
  disabled?: boolean;
  allLabel?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
          />
        }
      >
        Range shortcuts
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {historicalDateRangePresets.map((preset) => (
          <DropdownMenuItem
            key={preset.value}
            onClick={() => onSelect(resolveDateRange(preset.value))}
          >
            {preset.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onClick={() => onSelect({})}>
          {allLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import type { AmountKind } from "@cubby/recipebridge";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { ArrowLeftRight } from "lucide-react";
import { memo, useMemo } from "react";
import { Badge } from "~/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { safeConvertAmount } from "~/lib/recipe-costing";
import { ConversionDialog } from "./ConversionDialog";
import { formatKindsLabel, kindIconMap } from "./kind-icons";

interface ConversionCapabilitiesProps {
  mappings: UnitMapping[];
  hideConvertButton?: boolean;
  /** Compact mode hides the grid, showing only the header with Convert button and count badge */
  compact?: boolean;
}

interface ConversionTest {
  unit: string;
  from: AmountKind;
  to: AmountKind;
}

const testConversions: ConversionTest[] = [
  {
    unit: "g",
    from: "weight",
    to: "volume",
  },
  {
    unit: "g",
    from: "weight",
    to: "money",
  },
  {
    unit: "g",
    from: "weight",
    to: "calories",
  },
  {
    unit: "ml",
    from: "volume",
    to: "money",
  },
  {
    unit: "ml",
    from: "volume",
    to: "calories",
  },
  {
    unit: "$",
    from: "money",
    to: "calories",
  },
];

// kindIconMap and formatKindsLabel shared in kind-icons.ts

export const ConversionCapabilities = memo(function ConversionCapabilities({
  mappings,
  hideConvertButton = false,
  compact = false,
}: ConversionCapabilitiesProps) {
  // Skip expensive WASM conversion tests in compact mode (table view)
  // In compact mode, only show the Convert button without capability badges
  const capabilities = useMemo(() => {
    if (compact) return [];

    return testConversions.map((test) => {
      const result = safeConvertAmount(
        { unit: test.unit, value: 1 },
        mappings,
        test.to,
      );
      return {
        ...test,
        success: result.success,
      };
    });
  }, [mappings, compact]);

  const successCount = capabilities.filter((c) => c.success).length;
  const totalCount = capabilities.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {!hideConvertButton && <ConversionDialog mappings={mappings} />}
          {!compact && (
            <Badge variant="outline" className="text-muted-foreground">
              {successCount}/{totalCount}
            </Badge>
          )}
        </div>
      </div>

      {!compact && (
        <div className="grid grid-cols-3 gap-1 text-xs">
          {capabilities.map((capability) => {
            const label = formatKindsLabel(capability.from, capability.to);
            const FromIcon = kindIconMap[capability.from].Icon;
            const ToIcon = kindIconMap[capability.to].Icon;
            return (
              <div
                key={`${capability.from}-${capability.to}`}
                className={`flex items-center justify-center gap-1.5 rounded-md px-1.5 py-0.5 ${
                  capability.success
                    ? "border border-secondary bg-secondary/60 text-secondary-foreground"
                    : "border border-destructive/30 bg-destructive/10 text-muted-foreground/60"
                }`}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div className="flex items-center justify-center gap-1.5 p-0.5" />
                    }
                  >
                    <span className="sr-only">{label}</span>
                    <FromIcon className="h-3.5 w-3.5" aria-hidden />
                    <ArrowLeftRight
                      className="h-3.5 w-3.5 opacity-60"
                      aria-hidden
                    />
                    <ToIcon className="h-3.5 w-3.5" aria-hidden />
                  </TooltipTrigger>
                  <TooltipContent sideOffset={6}>{label}</TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

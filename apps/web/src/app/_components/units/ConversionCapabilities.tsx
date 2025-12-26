"use client";

import { useMemo } from "react";
import type { AmountKind } from "@recipehub/recipebridge";
import type { UnitMapping } from "~/schemas/unitmapping";
import { safeConvertAmount } from "./univ-conversion";
import { ConversionDialog } from "./ConversionDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { kindIconMap, formatKindsLabel } from "./kind-icons";
import { ArrowLeftRight } from "lucide-react";
import { Badge } from "~/components/ui/badge";

interface ConversionCapabilitiesProps {
  mappings: UnitMapping[];
  hideConvertButton?: boolean;
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

export function ConversionCapabilities({
  mappings,
  hideConvertButton = false,
}: ConversionCapabilitiesProps) {
  const capabilities = useMemo(() => {
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
  }, [mappings]);

  const successCount = capabilities.filter((c) => c.success).length;
  const totalCount = capabilities.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-xs">Unit Mappings</h4>
        <div className="flex items-center gap-2">
          {!hideConvertButton && <ConversionDialog mappings={mappings} />}
          <Badge variant="outline" className="text-muted-foreground">
            {successCount}/{totalCount}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1 text-[11px]">
        {capabilities.map((capability) => {
          const label = formatKindsLabel(capability.from, capability.to);
          const FromIcon = kindIconMap[capability.from].Icon;
          const ToIcon = kindIconMap[capability.to].Icon;
          return (
            <div
              key={`${capability.from}-${capability.to}`}
              className={`flex items-center justify-center gap-1.5 rounded-md px-1.5 py-0.5 ${
                capability.success
                  ? "border border-emerald-200 bg-emerald-50/60 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
                  : "border border-red-100 bg-red-50/50 text-muted-foreground/60"
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
    </div>
  );
}

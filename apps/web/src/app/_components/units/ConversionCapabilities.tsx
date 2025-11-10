"use client";

import * as React from "react";
import { useMemo } from "react";
import { MeasureKind } from "@recipehub/recipebridge";
import { UnitMapping } from "~/schemas/unitmapping";
import { useWasm } from "~/hooks/useWasm";
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
  from: MeasureKind;
  to: MeasureKind;
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
  const w = useWasm();

  const capabilities = useMemo(() => {
    return testConversions.map((test) => {
      const result = safeConvertAmount(
        w,
        { unit: test.unit, value: 1 },
        mappings,
        test.to,
      );
      return {
        ...test,
        success: result.success,
      };
    });
  }, [w, mappings]);

  const successCount = capabilities.filter((c) => c.success).length;
  const totalCount = capabilities.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium">Unit Mappings</h4>
        <div className="flex items-center gap-2">
          {!hideConvertButton && <ConversionDialog mappings={mappings} />}
          <Badge variant="outline" className="text-muted-foreground">
            {successCount}/{totalCount}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1 text-[11px]">
        {capabilities.map((capability, index) => {
          const label = formatKindsLabel(capability.from, capability.to);
          const FromIcon = kindIconMap[capability.from].Icon;
          const ToIcon = kindIconMap[capability.to].Icon;
          return (
            <div
              key={index}
              className={`flex items-center justify-center gap-1.5 rounded-md px-1.5 py-0.5 ${
                capability.success
                  ? "border border-emerald-200 bg-emerald-50/60 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
                  : "text-muted-foreground/60 border border-red-100 bg-red-50/50"
              }`}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center justify-center gap-1.5 p-0.5">
                    <span className="sr-only">{label}</span>
                    <FromIcon className="h-3.5 w-3.5" aria-hidden />
                    <ArrowLeftRight
                      className="h-3.5 w-3.5 opacity-60"
                      aria-hidden
                    />
                    <ToIcon className="h-3.5 w-3.5" aria-hidden />
                  </div>
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

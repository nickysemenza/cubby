"use client";

import * as React from "react";
import { useMemo } from "react";
import { MeasureKind } from "recipebridge/pkg/recipebridge";
import { Amount } from "~/codec/codec";
import { UnitMapping } from "~/schemas/unitmapping";
import { useWasm } from "~/hooks/useWasm";
import { safeConvertAmount } from "./univ-conversion";

interface ConversionCapabilitiesProps {
  mappings: UnitMapping[];
}

interface ConversionTest {
  from: Amount;
  to: MeasureKind;
  label: string;
}

const testConversions: ConversionTest[] = [
  { from: { value: 1, unit: "g" }, to: "volume", label: "Weight ↔ Volume" },
  { from: { value: 1, unit: "g" }, to: "money", label: "Weight ↔ Money" },
  {
    from: { value: 1, unit: "g" },
    to: "calories",
    label: "Weight ↔ Cal",
  },
  { from: { value: 1, unit: "ml" }, to: "money", label: "Volume ↔ Money" },
  {
    from: { value: 1, unit: "ml" },
    to: "calories",
    label: "Volume ↔ Cal",
  },
  { from: { value: 1, unit: "$" }, to: "calories", label: "Money ↔ Cal" },
];

export function ConversionCapabilities({
  mappings,
}: ConversionCapabilitiesProps) {
  const w = useWasm();

  const capabilities = useMemo(() => {
    return testConversions.map((test) => {
      const result = safeConvertAmount(w, test.from, mappings, test.to);
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
        <h4 className="text-sm font-medium">Conversion Capabilities</h4>
        <span className="text-muted-foreground text-xs">
          {successCount}/{totalCount} available
        </span>
      </div>

      <div className="grid grid-cols-2 gap-1 text-xs">
        {capabilities.map((capability, index) => (
          <div
            key={index}
            className={`rounded border px-1 py-1 ${
              capability.success
                ? "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
                : "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
            }`}
          >
            <span>{capability.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

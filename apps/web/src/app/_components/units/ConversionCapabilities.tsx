import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { ArrowLeftRight } from "lucide-react";
import { memo, useMemo } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  BASE_KINDS,
  type CoverageTier,
  conversionCoverage,
} from "~/lib/conversion-coverage";
import { ConversionDialog } from "./ConversionDialog";
import { formatKindsLabel, kindIconMap } from "./kind-icons";

interface ConversionCapabilitiesProps {
  mappings: UnitMapping[];
  hideConvertButton?: boolean;
  /** Compact mode hides the grid, showing only the header with Convert button */
  compact?: boolean;
  /**
   * Show the kind-coverage icons in compact mode too (off by default so narrow
   * table columns — e.g. the product list's `w-32` mapping column — aren't
   * clipped). The recipe table opts in; its mapping column is wide enough.
   */
  showCoverage?: boolean;
}

// kindIconMap and formatKindsLabel shared in kind-icons.ts

const TIER_LABEL: Record<CoverageTier, string> = {
  complete: "Complete",
  good: "Good",
  partial: "Partial",
  none: "None",
};

const TIER_CLASS: Record<CoverageTier, string> = {
  complete: "text-positive",
  good: "text-amber-600",
  partial: "text-muted-foreground",
  none: "text-destructive",
};

export const ConversionCapabilities = memo(function ConversionCapabilities({
  mappings,
  hideConvertButton = false,
  compact = false,
  showCoverage = false,
}: ConversionCapabilitiesProps) {
  // Detail view (non-compact) renders the per-pair grid + tier headline; compact
  // table cells render the kind icons (a summary of the same data) when opted
  // in. Skip the computation entirely for compact columns that don't opt in.
  const needCoverage = !compact || showCoverage;
  const coverage = useMemo(
    () => (needCoverage ? conversionCoverage(mappings) : null),
    [mappings, needCoverage],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {!hideConvertButton && (
            <ConversionDialog mappings={mappings} compact={compact} />
          )}

          {/* Compact: the kind icons are the whole story (no room for a grid).
              Lit when the kind converts to something; per-icon tooltips + sr-only
              labels carry the meaning. */}
          {coverage && compact && (
            <div className="flex items-center gap-0.5">
              {BASE_KINDS.map((kind) => {
                const { Icon, label } = kindIconMap[kind]!;
                const lit = coverage.covered.has(kind);
                const state = lit ? "convertible" : "no conversion";
                return (
                  <Tooltip key={kind}>
                    <TooltipTrigger
                      render={<span className="inline-flex p-0.5" />}
                    >
                      <span className="sr-only">{`${label}: ${state}`}</span>
                      <Icon
                        className={`h-3.5 w-3.5 ${lit ? "text-foreground" : "text-muted-foreground/40"}`}
                        aria-hidden
                      />
                    </TooltipTrigger>
                    <TooltipContent
                      sideOffset={6}
                    >{`${label}: ${state}`}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          )}

          {/* Detail: a one-word headline; the grid below is the detail. */}
          {coverage && !compact && (
            <span
              className={`font-mono text-2xs uppercase tracking-wide ${TIER_CLASS[coverage.tier]}`}
            >
              {TIER_LABEL[coverage.tier]}
            </span>
          )}
        </div>
      </div>

      {coverage && !compact && (
        <div className="grid grid-cols-3 gap-1 text-xs">
          {coverage.pairs.map((pair) => {
            const label = formatKindsLabel(pair.from, pair.to);
            const fromMeta = kindIconMap[pair.from];
            const toMeta = kindIconMap[pair.to];
            if (!fromMeta || !toMeta) return null;
            const FromIcon = fromMeta.Icon;
            const ToIcon = toMeta.Icon;
            return (
              <div
                key={`${pair.from}-${pair.to}`}
                className={`flex items-center justify-center gap-1.5 rounded-md px-1.5 py-0.5 ${
                  pair.success
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

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
  type BaseKind,
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
  /**
   * Show the one-word coverage tier (Complete/Good/Partial/None) in compact mode.
   * The ingredient/product list columns opt in so the cell reads as an at-a-glance
   * status rather than just a converter button. Suppressed when there are no
   * mappings at all (nothing to grade).
   */
  showTier?: boolean;
  /**
   * The measurement-kind universe to grade against. Defaults to all four
   * (weight/volume/money/calories). USDA contexts pass USDA_KINDS to drop money,
   * which a USDA food can never have.
   */
  kinds?: readonly BaseKind[];
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
  showTier = false,
  kinds,
}: ConversionCapabilitiesProps) {
  // Grade against the requested universe, defaulting to all four base kinds.
  // `kinds` is kept raw (possibly undefined) for forwarding to ConversionDialog,
  // which otherwise shows all 8 amount kinds — only USDA narrows it.
  const coverageKinds = kinds ?? BASE_KINDS;
  // Detail view (non-compact) renders the per-pair grid + tier headline; compact
  // table cells render the kind icons and/or the tier word (summaries of the same
  // data) when opted in. Skip the computation entirely for compact columns that
  // don't opt into either.
  const needCoverage = !compact || showCoverage || showTier;
  const coverage = useMemo(
    () => (needCoverage ? conversionCoverage(mappings, coverageKinds) : null),
    [mappings, needCoverage, coverageKinds],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {!hideConvertButton && (
            <ConversionDialog
              mappings={mappings}
              compact={compact}
              kinds={kinds}
            />
          )}

          {/* Compact tier word (Complete/Good/Partial/None), opt-in for list
              columns. Only when there are mappings to grade — an unmapped stub
              shouldn't read as a red "None". */}
          {coverage && compact && showTier && mappings.length > 0 && (
            <span
              className={`font-mono text-2xs uppercase tracking-wide ${TIER_CLASS[coverage.tier]}`}
            >
              {TIER_LABEL[coverage.tier]}
            </span>
          )}

          {/* Compact: the kind icons are the whole story (no room for a grid).
              Lit when the kind converts to something; per-icon tooltips + sr-only
              labels carry the meaning. */}
          {coverage && compact && showCoverage && (
            <div className="flex items-center gap-0.5">
              {coverageKinds.map((kind) => {
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

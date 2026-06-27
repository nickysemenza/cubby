import type { UnitMapping } from "@cubby/schemas/unitmapping-responses";
import { memo, useMemo } from "react";
import { Row, Stack } from "~/components/layout";
import { StatusText } from "~/components/ui/status-text";
import {
  BASE_KINDS,
  type BaseKind,
  type CoverageTier,
  conversionCoverage,
} from "~/lib/conversion-coverage";
import { ConversionDialog } from "./ConversionDialog";
import { CoverageChips, MacroChips } from "./CoverageChips";
import { KindIcon } from "./kind-icon";

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

const TIER_LABEL: Record<CoverageTier, string> = {
  complete: "Complete",
  good: "Good",
  partial: "Partial",
  none: "None",
};

const TIER_TONE = {
  complete: "positive",
  good: "warning",
  partial: "muted",
  none: "destructive",
} as const satisfies Record<
  CoverageTier,
  "positive" | "warning" | "muted" | "destructive"
>;

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
    <Stack gap="sm">
      <Row align="center" justify="between">
        <Row align="center" gap="sm">
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
            <StatusText
              tone={TIER_TONE[coverage.tier]}
              className="font-mono text-2xs uppercase tracking-wide"
            >
              {TIER_LABEL[coverage.tier]}
            </StatusText>
          )}

          {/* Compact: the kind icons are the whole story (no room for a grid).
              Lit when the kind converts to something; per-icon tooltips + sr-only
              labels carry the meaning. */}
          {coverage && compact && showCoverage && (
            <Row align="center" gap="tight">
              {coverageKinds.map((kind) => (
                <KindIcon
                  key={kind}
                  kind={kind}
                  lit={coverage.covered.has(kind)}
                  className={"p-0.5" /* tight */}
                />
              ))}
            </Row>
          )}

          {/* Detail: a one-word headline; the grid below is the detail. */}
          {coverage && !compact && (
            <StatusText
              tone={TIER_TONE[coverage.tier]}
              className="font-mono text-2xs uppercase tracking-wide"
            >
              {TIER_LABEL[coverage.tier]}
            </StatusText>
          )}
        </Row>
      </Row>

      {/* Detail: the big-4 chips (the directional pair grid's data, summarized
          per kind — same vocabulary the workbench and list cells use) plus the
          macro chips (protein/fat/carbs/fiber/sodium the recipe table consumes).
          `applicable` lets a USDA 3-kind universe strike money through. */}
      {coverage && !compact && (
        <Stack gap="sm">
          <CoverageChips
            covered={[...coverage.covered]}
            applicable={[...coverageKinds]}
          />
          <MacroChips mappings={mappings} />
        </Stack>
      )}
    </Stack>
  );
});

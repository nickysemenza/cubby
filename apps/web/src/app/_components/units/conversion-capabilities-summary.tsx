import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { type ReactNode, useMemo } from "react";

import { Row, Stack } from "~/components/layout";
import { StatusText } from "~/components/ui/status-text";
import {
  BASE_KINDS,
  type BaseKind,
  type CoverageTier,
  conversionCoverage,
} from "~/lib/conversion-coverage";

import { CoverageChips, MacroChips } from "./CoverageChips";
import { KindIcon } from "./kind-icon";

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

export function ConversionCapabilitiesSummary({
  mappings,
  compact = false,
  showCoverage = false,
  showTier = false,
  kinds,
  action,
}: {
  mappings: UnitMapping[];
  compact?: boolean;
  showCoverage?: boolean;
  showTier?: boolean;
  kinds?: readonly BaseKind[];
  action?: ReactNode;
}) {
  const coverageKinds = kinds ?? BASE_KINDS;
  const needCoverage = !compact || showCoverage || showTier;
  const coverage = useMemo(
    () => (needCoverage ? conversionCoverage(mappings, coverageKinds) : null),
    [mappings, needCoverage, coverageKinds],
  );

  return (
    <Stack gap="sm">
      <Row align="center" justify="between">
        <Row align="center" gap="sm">
          {action}
          {coverage && compact && showTier && mappings.length > 0 && (
            <StatusText
              tone={TIER_TONE[coverage.tier]}
              className="font-mono text-2xs tracking-wide uppercase"
            >
              {TIER_LABEL[coverage.tier]}
            </StatusText>
          )}
          {coverage && compact && showCoverage && (
            <Row align="center" gap="tight">
              {coverageKinds.map((kind) => (
                <KindIcon
                  key={kind}
                  kind={kind}
                  lit={coverage.covered.has(kind)}
                  className="p-0.5" /* tight: compact coverage glyph */
                />
              ))}
            </Row>
          )}
          {coverage && !compact && (
            <StatusText
              tone={TIER_TONE[coverage.tier]}
              className="font-mono text-2xs tracking-wide uppercase"
            >
              {TIER_LABEL[coverage.tier]}
            </StatusText>
          )}
        </Row>
      </Row>
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
}

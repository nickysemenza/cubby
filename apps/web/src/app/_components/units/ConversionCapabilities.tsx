import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { memo } from "react";
import type { BaseKind } from "~/lib/conversion-coverage";
import { ConversionDialog } from "./ConversionDialog";
import { ConversionCapabilitiesSummary } from "./conversion-capabilities-summary";

interface ConversionCapabilitiesProps {
  mappings: UnitMapping[];
  hideConvertButton?: boolean;
  compact?: boolean;
  showCoverage?: boolean;
  showTier?: boolean;
  kinds?: readonly BaseKind[];
}

export const ConversionCapabilities = memo(function ConversionCapabilities({
  mappings,
  hideConvertButton = false,
  compact = false,
  showCoverage = false,
  showTier = false,
  kinds,
}: ConversionCapabilitiesProps) {
  return (
    <ConversionCapabilitiesSummary
      mappings={mappings}
      compact={compact}
      showCoverage={showCoverage}
      showTier={showTier}
      kinds={kinds}
      action={
        hideConvertButton ? undefined : (
          <ConversionDialog
            mappings={mappings}
            compact={compact}
            kinds={kinds}
          />
        )
      }
    />
  );
});

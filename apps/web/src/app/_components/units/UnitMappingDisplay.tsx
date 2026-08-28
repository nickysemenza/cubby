import type { UnitMapping } from "@cubby/schemas/unitmapping";

import { Stack } from "~/components/layout";
import type { BaseKind } from "~/lib/conversion-coverage";

import { ConversionCapabilities } from "./ConversionCapabilities";
import { UnitPriceLine } from "./unit-price-line";

interface UnitMappingDisplayProps {
  mappings: UnitMapping[];
  title?: string;
  /** Compact mode hides the conversion grid, showing only Convert button and count */
  compact?: boolean;
  /** Show the kind-coverage icons even in compact mode (opt-in per column width). */
  showCoverage?: boolean;
  /** Show the one-word coverage tier (Complete/Good/Partial/None) in compact mode. */
  showTier?: boolean;
  /** Measurement-kind universe to grade against (USDA passes USDA_KINDS). */
  kinds?: readonly BaseKind[];
  /**
   * Show the derived per-unit price beside the coverage chips.
   *
   * Off by default because the two consumers differ: a USDA food has no price
   * by definition (which is why USDA_KINDS drops money), so the line would
   * always be empty there and only cost a WASM call per row.
   */
  showUnitPrice?: boolean;
}

export const UnitMappingDisplay: React.FC<UnitMappingDisplayProps> = ({
  mappings,
  title = "Unit Conversions",
  compact = false,
  showCoverage = false,
  showTier = false,
  kinds,
  showUnitPrice = false,
}) => {
  return (
    <div>
      {title && <h3 className="mb-4 font-heading font-medium">{title}</h3>}
      <Stack gap="md">
        <ConversionCapabilities
          mappings={mappings}
          compact={compact}
          showCoverage={showCoverage}
          showTier={showTier}
          kinds={kinds}
        />
        {showUnitPrice && (
          <UnitPriceLine mappings={mappings} compact={compact} />
        )}
      </Stack>
    </div>
  );
};

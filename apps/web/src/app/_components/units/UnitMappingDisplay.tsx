import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { ConversionCapabilities } from "./ConversionCapabilities";

interface UnitMappingDisplayProps {
  mappings: UnitMapping[];
  title?: string;
  /** Compact mode hides the conversion grid, showing only Convert button and count */
  compact?: boolean;
  /** Show the kind-coverage icons even in compact mode (opt-in per column width). */
  showCoverage?: boolean;
  /** Show the one-word coverage tier (Complete/Good/Partial/None) in compact mode. */
  showTier?: boolean;
}

export const UnitMappingDisplay: React.FC<UnitMappingDisplayProps> = ({
  mappings,
  title = "Unit Conversions",
  compact = false,
  showCoverage = false,
  showTier = false,
}) => {
  return (
    <div>
      {title && <h3 className="mb-3 font-heading font-medium">{title}</h3>}
      <div className="space-y-4">
        <ConversionCapabilities
          mappings={mappings}
          compact={compact}
          showCoverage={showCoverage}
          showTier={showTier}
        />
      </div>
    </div>
  );
};

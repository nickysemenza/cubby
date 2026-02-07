import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { ConversionCapabilities } from "./ConversionCapabilities";

interface UnitMappingDisplayProps {
  mappings: UnitMapping[];
  title?: string;
  /** Compact mode hides the conversion grid, showing only Convert button and count */
  compact?: boolean;
}

export const UnitMappingDisplay: React.FC<UnitMappingDisplayProps> = ({
  mappings,
  title = "Unit Conversions",
  compact = false,
}) => {
  return (
    <div>
      {title && <h3 className="mb-3 font-heading font-medium">{title}</h3>}
      <div className="space-y-4">
        <ConversionCapabilities mappings={mappings} compact={compact} />
      </div>
    </div>
  );
};

"use client";

import type { UnitMapping } from "~/schemas/unitmapping";
import { ConversionCapabilities } from "./ConversionCapabilities";

interface UnitMappingDisplayProps {
  mappings: UnitMapping[];
  title?: string;
}

export const UnitMappingDisplay: React.FC<UnitMappingDisplayProps> = ({
  mappings,
  title = "Unit Conversions",
}) => {
  return (
    <div>
      {title && <h3 className="mb-3">{title}</h3>}
      <div className="space-y-4">
        <ConversionCapabilities mappings={mappings} />
      </div>
    </div>
  );
};

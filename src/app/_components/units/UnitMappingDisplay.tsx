"use client";

import { UnitMapping } from "~/schemas/unitmapping";
import { UnitMappingsTable } from "./unitmappingstable";
import { ConversionCapabilities } from "./ConversionCapabilities";
import { ConversionDialog } from "./ConversionDialog";

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
      <div className="mb-3 flex items-center justify-between">
        {title && <h3>{title}</h3>}
        <ConversionDialog mappings={mappings} />
      </div>
      <div className="space-y-4">
        <ConversionCapabilities mappings={mappings} />
      </div>
    </div>
  );
};

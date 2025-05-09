"use client";

import { UnitMapping } from "~/schemas/unitmapping";
import { wasm } from "~/wasmContext";
import { UnitMappingsTable } from "./unitmappingstable";
import { buildunitMappingsGraph } from "./UnitMappingGraph";
import { ConversionDialog } from "./ConversionDialog";

export interface UnitMappingDisplayProps {
  mappings: UnitMapping[];
  w: wasm;
  title?: string;
}

export const UnitMappingDisplay: React.FC<UnitMappingDisplayProps> = ({
  mappings,
  w,
  title = "Unit Conversions",
}) => {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        {title && <h3>{title}</h3>}
        <ConversionDialog mappings={mappings} w={w} />
      </div>
      <div className="space-y-4">
        <UnitMappingsTable mappings={mappings} w={w} />
        <div className="pt-2">{buildunitMappingsGraph(w, mappings)}</div>
      </div>
    </div>
  );
};

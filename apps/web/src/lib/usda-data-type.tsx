import { type DataType, dataTypeLabel } from "@cubby/usda-schemas";

import { cn } from "~/lib/utils";

// Color per USDA data_type, encoding BOTH identity and the generic/branded
// grouping along the monochrome ink ladder. The richest reference foods take
// the accent (SR Legacy = chart-1 ultramarine, the house primary, since it's
// the richest source), the next tiers step down the ink ladder, and the
// sampling/research types collapse to the lightest grey (provenance noise).
// Richness ordering (SR Legacy > Survey > Foundation > Branded) is reinforced
// by result sort order + the nutrient count shown alongside, not by color alone.
//
// Tokens only (AGENTS.md): never hardcode hex/oklch — these are the chart
// ink-ladder + semantic tokens from styles.css, referenced as CSS vars so a
// single record drives dots and tinted icons everywhere.
const DATA_TYPE_COLOR = {
  sr_legacy_food: "var(--chart-1)",
  survey_fndds_food: "var(--chart-2)",
  foundation_food: "var(--chart-3)",
  branded_food: "var(--chart-5)",
  agricultural_acquisition: "var(--chart-8)",
  market_acquisition: "var(--chart-8)",
  sample_food: "var(--chart-8)",
  sub_sample_food: "var(--chart-8)",
  experimental_food: "var(--chart-8)",
} satisfies Record<DataType, string>;

export function dataTypeColor(dataType: DataType): string {
  return DATA_TYPE_COLOR[dataType];
}

// Small color swatch identifying a USDA data_type. Decorative — the adjacent
// label carries the meaning for screen readers.
export function UsdaDataTypeDot({
  dataType,
  className,
}: {
  dataType: DataType;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      title={dataTypeLabel(dataType)}
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: DATA_TYPE_COLOR[dataType] }}
    />
  );
}

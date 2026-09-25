import {
  hasKnownEstimate,
  measureEstimate,
  nutritionEstimate,
  nutritionTotals,
  type MeasureEstimate,
} from "@cubby/schemas/nutrition";
import * as React from "react";
import { match } from "ts-pattern";
import { z } from "zod";

import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  StatGrid,
  StatTile,
  type SummaryItem,
} from "~/components/ui/stat-tile";
import { formatEstimate } from "~/lib/nutrition-format";
import { formatCurrency } from "~/lib/utils";

// Zod schemas for summary data types
const recipeSummaryDataSchema = nutritionTotals.extend({
  /** Weight is outside NutritionTotals but useful for a recipe summary. */
  weight: measureEstimate.optional(),
});

const nutritionSummaryDataSchema = nutritionEstimate;

const inventorySummaryDataSchema = z.object({
  totalValue: z.number(),
  itemCount: z.number(),
  locationCount: z.number(),
  lastUpdated: z.date().optional(),
});

// Schema for serializable summary items (without formatter function)
const summaryItemSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
});

const customSummaryDataSchema = z.object({
  items: z.array(summaryItemSchema),
});

export const entitySummaryDataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recipe"), data: recipeSummaryDataSchema }),
  z.object({ type: z.literal("nutrition"), data: nutritionSummaryDataSchema }),
  z.object({ type: z.literal("inventory"), data: inventorySummaryDataSchema }),
  z.object({ type: z.literal("custom"), data: customSummaryDataSchema }),
]);

// Derived types from Zod schemas
type RecipeSummaryData = z.infer<typeof recipeSummaryDataSchema>;
type NutritionSummaryData = z.infer<typeof nutritionSummaryDataSchema>;
type InventorySummaryData = z.infer<typeof inventorySummaryDataSchema>;

// CustomSummaryData uses SummaryItem which includes optional formatter function
// (formatter is not in Zod schema since functions aren't serializable)
interface CustomSummaryData {
  items: SummaryItem[];
}

// EntitySummaryData type - extends Zod schema with formatter support for custom type
type EntitySummaryData =
  | { type: "recipe"; data: RecipeSummaryData }
  | { type: "nutrition"; data: NutritionSummaryData }
  | { type: "inventory"; data: InventorySummaryData }
  | { type: "custom"; data: CustomSummaryData };

interface EntitySummaryCardProps {
  title?: string;
  description?: string;
  className?: string;
  summaryData: EntitySummaryData;
}

const formatRecipeSummary = (data: RecipeSummaryData): SummaryItem[] => {
  const buildMetric = (
    label: string,
    estimate: MeasureEstimate,
    formatNumber: (value: number) => string,
  ): SummaryItem => ({
    label,
    value: formatEstimate(estimate, formatNumber),
    caption:
      hasKnownEstimate(estimate) && estimate.status === "partial"
        ? `${estimate.coverage.covered}/${estimate.coverage.total} ingredients`
        : undefined,
  });

  return [
    buildMetric("Total Cost", data.cost, formatCurrency),
    ...(data.weight
      ? [
          buildMetric(
            "Total Weight",
            data.weight,
            (value) => `${Math.round(value)}g`,
          ),
        ]
      : []),
    buildMetric(
      "Total Calories",
      data.nutrition.kcal,
      (value) => `${Math.round(value)} kcal`,
    ),
    buildMetric(
      "Total Protein",
      data.nutrition.protein,
      (value) => `${value.toFixed(1)}g`,
    ),
  ];
};

const formatNutritionSummary = (data: NutritionSummaryData): SummaryItem[] => {
  const metric = (
    label: string,
    estimate: MeasureEstimate,
    formatNumber: (value: number) => string,
  ): SummaryItem => ({
    label,
    value: formatEstimate(estimate, formatNumber),
  });

  return [
    metric("Calories", data.kcal, (value) => `${Math.round(value)} kcal`),
    metric("Protein", data.protein, (value) => `${value.toFixed(1)}g`),
    metric("Carbs", data.carbs, (value) => `${value.toFixed(1)}g`),
    metric("Fat", data.fat, (value) => `${value.toFixed(1)}g`),
    metric("Fiber", data.fiber, (value) => `${value.toFixed(1)}g`),
    metric("Sodium", data.sodium, (value) => `${value.toFixed(1)} mg`),
  ];
};

const formatInventorySummary = (data: InventorySummaryData): SummaryItem[] => [
  {
    label: "Total Value",
    value: data.totalValue,
    formatter: (value) => formatCurrency(Number(value)),
  },
  {
    label: "Items",
    value: data.itemCount,
    formatter: (value) => `${Number(value)} items`,
  },
  {
    label: "Locations",
    value: data.locationCount,
    formatter: (value) => `${Number(value)} locations`,
  },
  ...(data.lastUpdated
    ? [
        {
          label: "Last Updated",
          value: data.lastUpdated.toLocaleDateString(),
        },
      ]
    : []),
];

export const EntitySummaryCard: React.FC<EntitySummaryCardProps> = ({
  title = "Summary",
  description,
  className,
  summaryData,
}) => {
  const items = React.useMemo(
    () =>
      match(summaryData)
        .with({ type: "recipe" }, (d) => formatRecipeSummary(d.data))
        .with({ type: "nutrition" }, (d) => formatNutritionSummary(d.data))
        .with({ type: "inventory" }, (d) => formatInventorySummary(d.data))
        .with({ type: "custom" }, (d) => d.data.items)
        .exhaustive(),
    [summaryData],
  );

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle>{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        <StatGrid>
          {items.map((item) => (
            <StatTile key={item.label} item={item} />
          ))}
        </StatGrid>
      </CardContent>
    </Card>
  );
};

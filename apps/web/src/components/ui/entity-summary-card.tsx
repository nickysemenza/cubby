import * as React from "react";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { SummaryGrid } from "~/components/ui/summary-grid";
import { type SummaryItem } from "~/app/_components/SummaryCard";
import {
  getNutrientDisplayName,
  getNutrientUnit,
} from "@recipehub/usda-schemas";

// Zod schemas for summary data types
export const recipeSummaryDataSchema = z.object({
  price: z.number(),
  weight: z.number(),
  nutrients: z.record(z.string(), z.number()),
  totalIngredients: z.number(),
  missingByType: z.object({
    price: z.array(z.string()),
    weight: z.array(z.string()),
    nutrients: z.array(z.string()),
  }),
});

export const nutritionSummaryDataSchema = z.object({
  calories: z.number(),
  protein: z.number(),
  carbs: z.number(),
  fat: z.number(),
  fiber: z.number().optional(),
  sugar: z.number().optional(),
});

export const inventorySummaryDataSchema = z.object({
  totalValue: z.number(),
  itemCount: z.number(),
  locationCount: z.number(),
  lastUpdated: z.date().optional(),
});

// Schema for serializable summary items (without formatter function)
export const summaryItemSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
});

export const customSummaryDataSchema = z.object({
  items: z.array(summaryItemSchema),
});

export const entitySummaryDataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recipe"), data: recipeSummaryDataSchema }),
  z.object({ type: z.literal("nutrition"), data: nutritionSummaryDataSchema }),
  z.object({ type: z.literal("inventory"), data: inventorySummaryDataSchema }),
  z.object({ type: z.literal("custom"), data: customSummaryDataSchema }),
]);

// Derived types from Zod schemas
export type RecipeSummaryData = z.infer<typeof recipeSummaryDataSchema>;
export type NutritionSummaryData = z.infer<typeof nutritionSummaryDataSchema>;
export type InventorySummaryData = z.infer<typeof inventorySummaryDataSchema>;

// CustomSummaryData uses SummaryItem which includes optional formatter function
// (formatter is not in Zod schema since functions aren't serializable)
export interface CustomSummaryData {
  items: SummaryItem[];
}

// EntitySummaryData type - extends Zod schema with formatter support for custom type
export type EntitySummaryData =
  | { type: "recipe"; data: RecipeSummaryData }
  | { type: "nutrition"; data: NutritionSummaryData }
  | { type: "inventory"; data: InventorySummaryData }
  | { type: "custom"; data: CustomSummaryData };

export interface EntitySummaryCardProps {
  title?: string;
  description?: string;
  className?: string;
  summaryData: EntitySummaryData;
}

// Priority nutrients to display in summary (kcal and protein)
const SUMMARY_NUTRIENT_CODES = ["208", "203"] as const; // kcal, protein

// Helper functions for each summary type
const formatRecipeSummary = (data: RecipeSummaryData): SummaryItem[] => {
  const formatWithCoverage = (
    value: number,
    missingCount: number,
    total: number,
    unit: string,
    prefix = "",
  ) => {
    const successCount = total - missingCount;
    if (successCount === 0) {
      return "No data available";
    }
    if (successCount === total) {
      return `${prefix}${value.toFixed(value < 10 ? 2 : 0)}${unit}`;
    }
    return `${prefix}${value.toFixed(value < 10 ? 2 : 0)}${unit} (${successCount}/${total} ingredients)`;
  };

  // Generate nutrient items for priority nutrients
  const nutrientItems = SUMMARY_NUTRIENT_CODES.map((code) => {
    const value = data.nutrients[code] ?? 0;
    const displayName = getNutrientDisplayName(code);
    const unit = getNutrientUnit(code).toLowerCase();
    return {
      label: `Total ${displayName}`,
      value,
      formatter: () =>
        formatWithCoverage(
          value,
          data.missingByType.nutrients.length,
          data.totalIngredients,
          code === "208" ? " kcal" : unit, // Special formatting for kcal
        ),
    };
  });

  return [
    {
      label: "Total Cost",
      value: data.price,
      formatter: () =>
        formatWithCoverage(
          data.price,
          data.missingByType.price.length,
          data.totalIngredients,
          "",
          "$",
        ),
    },
    {
      label: "Total Weight",
      value: data.weight,
      formatter: () =>
        formatWithCoverage(
          data.weight,
          data.missingByType.weight.length,
          data.totalIngredients,
          "g",
        ),
    },
    ...nutrientItems,
    ...(data.missingByType.price.length > 0 ||
    data.missingByType.weight.length > 0 ||
    data.missingByType.nutrients.length > 0
      ? [
          {
            label: "Missing Data",
            value: "",
            formatter: () => {
              const parts = [];
              if (data.missingByType.price.length > 0) {
                parts.push(`Price (${data.missingByType.price.join(", ")})`);
              }
              if (data.missingByType.weight.length > 0) {
                parts.push(`Weight (${data.missingByType.weight.join(", ")})`);
              }
              if (data.missingByType.nutrients.length > 0) {
                parts.push(
                  `Nutrition (${data.missingByType.nutrients.join(", ")})`,
                );
              }
              return parts.join(", ");
            },
          },
        ]
      : []),
  ];
};

const formatNutritionSummary = (data: NutritionSummaryData): SummaryItem[] => [
  {
    label: "Calories",
    value: data.calories,
    formatter: (value) => `${Number(value).toFixed(0)} kcal`,
  },
  {
    label: "Protein",
    value: data.protein,
    formatter: (value) => `${Number(value).toFixed(1)}g`,
  },
  {
    label: "Carbs",
    value: data.carbs,
    formatter: (value) => `${Number(value).toFixed(1)}g`,
  },
  {
    label: "Fat",
    value: data.fat,
    formatter: (value) => `${Number(value).toFixed(1)}g`,
  },
  ...(data.fiber !== undefined
    ? [
        {
          label: "Fiber",
          value: data.fiber,
          formatter: (value: string | number) => `${Number(value).toFixed(1)}g`,
        },
      ]
    : []),
  ...(data.sugar !== undefined
    ? [
        {
          label: "Sugar",
          value: data.sugar,
          formatter: (value: string | number) => `${Number(value).toFixed(1)}g`,
        },
      ]
    : []),
];

const formatInventorySummary = (data: InventorySummaryData): SummaryItem[] => [
  {
    label: "Total Value",
    value: data.totalValue,
    formatter: (value) => `$${Number(value).toFixed(2)}`,
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
  // Get formatted items based on summary type
  const items = React.useMemo(() => {
    switch (summaryData.type) {
      case "recipe":
        return formatRecipeSummary(summaryData.data);
      case "nutrition":
        return formatNutritionSummary(summaryData.data);
      case "inventory":
        return formatInventorySummary(summaryData.data);
      case "custom":
        return summaryData.data.items;
      default:
        return [];
    }
  }, [summaryData]);

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle>{title}</CardTitle>
        {description && (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        <SummaryGrid>
          {items.map((item, index) => (
            <div key={index}>
              <div className="text-muted-foreground text-sm">{item.label}</div>
              <div className="font-medium">
                {item.formatter ? item.formatter(item.value) : item.value}
              </div>
            </div>
          ))}
        </SummaryGrid>
      </CardContent>
    </Card>
  );
};

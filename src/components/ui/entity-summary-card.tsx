import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { SummaryGrid } from "~/components/ui/summary-grid";
import { type SummaryItem } from "~/app/_components/SummaryCard";

// Recipe summary data
export interface RecipeSummaryData {
  price: number;
  weight: number;
  kcal: number;
  protein: number;
  missing: string[];
}

// Nutrition summary data
export interface NutritionSummaryData {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
  sugar?: number;
}

// Inventory summary data
export interface InventorySummaryData {
  totalValue: number;
  itemCount: number;
  locationCount: number;
  lastUpdated?: Date;
}

// Custom summary data (flexible)
export interface CustomSummaryData {
  items: SummaryItem[];
}

// Discriminated union for different summary types
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

// Helper functions for each summary type
const formatRecipeSummary = (data: RecipeSummaryData): SummaryItem[] => [
  {
    label: "Total Cost",
    value: data.price,
    formatter: (value) => `$${Number(value).toFixed(2)}`,
  },
  {
    label: "Total Weight",
    value: data.weight,
    formatter: (value) => `${Number(value).toFixed(0)}g`,
  },
  {
    label: "Total Calories",
    value: data.kcal,
    formatter: (value) => `${Number(value).toFixed(0)} kcal`,
  },
  {
    label: "Total Protein",
    value: data.protein,
    formatter: (value) => `${Number(value).toFixed(0)}g`,
  },
  ...(data.missing.length > 0
    ? [
        {
          label: "Missing Data",
          value: data.missing.join(", "),
        },
      ]
    : []),
];

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

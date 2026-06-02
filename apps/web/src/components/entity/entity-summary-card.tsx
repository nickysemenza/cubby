import { getNutrientDisplayName, getNutrientUnit } from "@cubby/usda-schemas";
import * as React from "react";
import { z } from "zod";
import type { SummaryItem } from "~/app/_components/SummaryCard";
import { GridContainer } from "~/components/layout/grid-container";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { formatCurrency } from "~/lib/utils";

// Zod schemas for summary data types
const recipeSummaryDataSchema = z.object({
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

const nutritionSummaryDataSchema = z.object({
  calories: z.number(),
  protein: z.number(),
  carbs: z.number(),
  fat: z.number(),
  fiber: z.number().optional(),
  sugar: z.number().optional(),
});

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
export type RecipeSummaryData = z.infer<typeof recipeSummaryDataSchema>;
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

// Priority nutrients to display in summary (kcal and protein)
const SUMMARY_NUTRIENT_CODES = ["208", "203"] as const; // kcal, protein

// Helper functions for each summary type
const formatRecipeSummary = (data: RecipeSummaryData): SummaryItem[] => {
  // Builds one metric: a clean value plus an optional small coverage caption.
  // Keeping coverage out of the value prevents the big number from wrapping into
  // adjacent grid columns.
  const buildMetric = (
    label: string,
    value: number,
    missingCount: number,
    total: number,
    unit: string,
    prefix = "",
  ): SummaryItem => {
    const successCount = total - missingCount;
    if (successCount === 0) {
      return { label, value: "No data available" };
    }
    return {
      label,
      value: `${prefix}${value.toFixed(value < 10 ? 2 : 0)}${unit}`,
      caption:
        successCount === total
          ? undefined
          : `${successCount}/${total} ingredients`,
    };
  };

  // Generate nutrient items for priority nutrients
  const nutrientItems = SUMMARY_NUTRIENT_CODES.map((code) => {
    const value = data.nutrients[code] ?? 0;
    const displayName = getNutrientDisplayName(code);
    const unit = getNutrientUnit(code).toLowerCase();
    return buildMetric(
      `Total ${displayName}`,
      value,
      data.missingByType.nutrients.length,
      data.totalIngredients,
      code === "208" ? " kcal" : unit, // Special formatting for kcal
    );
  });

  return [
    buildMetric(
      "Total Cost",
      data.price,
      data.missingByType.price.length,
      data.totalIngredients,
      "",
      "$",
    ),
    buildMetric(
      "Total Weight",
      data.weight,
      data.missingByType.weight.length,
      data.totalIngredients,
      "g",
    ),
    ...nutrientItems,
  ];
};

// Missing-data footer, rendered below the summary grid for recipes so the long
// list of ingredient names doesn't dominate a single cramped grid cell.
const MissingDataFooter: React.FC<{
  missingByType: RecipeSummaryData["missingByType"];
}> = ({ missingByType }) => {
  const categories = [
    { label: "Price", names: missingByType.price },
    { label: "Weight", names: missingByType.weight },
    { label: "Nutrition", names: missingByType.nutrients },
  ].filter((c) => c.names.length > 0);

  if (categories.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 space-y-2 border-foreground/10 border-t pt-3">
      <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Missing data
      </div>
      {categories.map((category) => (
        <div
          key={category.label}
          className="flex flex-wrap items-baseline gap-1.5"
        >
          <span className="font-medium text-foreground text-sm">
            {category.label}
            <span className="text-muted-foreground">
              {" "}
              · {category.names.length}
            </span>
          </span>
          {category.names.map((name) => (
            <Badge key={name} variant="outline" className="font-normal">
              {name}
            </Badge>
          ))}
        </div>
      ))}
    </div>
  );
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
        <GridContainer cols="summary">
          {items.map((item) => (
            <div key={item.label}>
              <div className="text-muted-foreground text-sm">{item.label}</div>
              <div className="font-semibold text-foreground text-lg">
                {item.formatter ? item.formatter(item.value) : item.value}
              </div>
              {item.caption && (
                <div className="text-muted-foreground text-xs">
                  {item.caption}
                </div>
              )}
            </div>
          ))}
        </GridContainer>
        {summaryData.type === "recipe" && (
          <MissingDataFooter missingByType={summaryData.data.missingByType} />
        )}
      </CardContent>
    </Card>
  );
};

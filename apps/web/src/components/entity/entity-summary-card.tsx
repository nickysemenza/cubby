import * as React from "react";
import { match } from "ts-pattern";
import { z } from "zod";
import {
  perServingRange,
  perUnitSuffix,
  recipeHeadlineTotals,
} from "~/app/_components/recipe/recipe-utils";
import type { SummaryItem } from "~/app/_components/SummaryCard";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { StatGrid, StatTile } from "~/components/ui/stat-tile";
import { formatNumberRange } from "~/lib/format-range";
import { formatCurrency } from "~/lib/utils";

// Zod schemas for summary data types
const recipeSummaryDataSchema = z.object({
  price: z.number(),
  priceUpper: z.number().optional(),
  weight: z.number(),
  weightUpper: z.number().optional(),
  nutrients: z.record(z.string(), z.number()),
  /** Parallel upper-bound record (only ranged codes), for min–max display. */
  nutrientsUpper: z.record(z.string(), z.number()).optional(),
  totalIngredients: z.number(),
  missingByType: z.object({
    price: z.array(z.string()),
    weight: z.array(z.string()),
    nutrients: z.array(z.string()),
  }),
  /** Per-portion basis; when present each metric gains a "/ {noun}" sub-line. */
  perServing: z
    .object({ divisor: z.number(), noun: z.string() })
    .nullable()
    .optional(),
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

// Helper functions for each summary type
const formatRecipeSummary = (data: RecipeSummaryData): SummaryItem[] => {
  // Builds one metric: a clean value plus an optional small coverage caption.
  // Keeping coverage out of the value prevents the big number from wrapping into
  // adjacent grid columns.
  const format = (n: number, unit: string, prefix: string) =>
    `${prefix}${n.toFixed(n < 10 ? 2 : 0)}${unit}`;

  const buildMetric = (
    label: string,
    value: number,
    missingCount: number,
    total: number,
    unit: string,
    prefix = "",
    upper?: number,
  ): SummaryItem => {
    const successCount = total - missingCount;
    if (successCount === 0) {
      return { label, value: "No data available" };
    }
    const fmt = (n: number) => format(n, unit, prefix);
    const basis = data.perServing;
    const per = basis && perServingRange(value, upper, basis.divisor);
    return {
      label,
      value: formatNumberRange(value, upper, fmt),
      caption:
        successCount === total
          ? undefined
          : `${successCount}/${total} ingredients`,
      subValue:
        basis && per
          ? `${formatNumberRange(per.value, per.upper, fmt)} ${perUnitSuffix(basis.noun)}`
          : undefined,
    };
  };

  // The four headline figures, defined once in recipeHeadlineTotals so the table,
  // charts, and magazine kicker agree on which numbers they are.
  const head = recipeHeadlineTotals(data);
  const nutrientsMissing = data.missingByType.nutrients.length;
  return [
    buildMetric(
      "Total Cost",
      head.cost,
      data.missingByType.price.length,
      data.totalIngredients,
      "",
      "$",
      head.costUpper,
    ),
    buildMetric(
      "Total Weight",
      head.weight,
      data.missingByType.weight.length,
      data.totalIngredients,
      "g",
      "",
      head.weightUpper,
    ),
    buildMetric(
      "Total Calories",
      head.calories,
      nutrientsMissing,
      data.totalIngredients,
      " kcal",
      "",
      head.caloriesUpper,
    ),
    buildMetric(
      "Total Protein",
      head.protein,
      nutrientsMissing,
      data.totalIngredients,
      "g",
      "",
      head.proteinUpper,
    ),
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
      <div className="font-medium font-mono text-2xs text-eyebrow uppercase tracking-wider">
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
          {category.names.map((name, index) => (
            <Badge
              // Names can repeat (a recipe may list the same ingredient twice),
              // so the name alone isn't unique; this list is static (no reorder).
              // biome-ignore lint/suspicious/noArrayIndexKey: names aren't unique and the list is static
              key={`${name}-${index}`}
              variant="outline"
              className="font-normal"
            >
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
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        <StatGrid>
          {items.map((item) => (
            <StatTile key={item.label} item={item} />
          ))}
        </StatGrid>
        {summaryData.type === "recipe" && (
          <MissingDataFooter missingByType={summaryData.data.missingByType} />
        )}
      </CardContent>
    </Card>
  );
};

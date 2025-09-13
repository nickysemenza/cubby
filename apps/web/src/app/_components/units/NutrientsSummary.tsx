import { NutrientsPer100 } from "@recipehub/usda-schemas";

export function NutrientsSummary({
  nutrients,
}: {
  nutrients: NutrientsPer100;
}) {
  return (
    <div className="space-y-1 text-xs">
      <div className="border-muted border px-2 py-1">
        <span className="text-chart-2 font-medium">CALORIES:</span>{" "}
        <span className="text-chart-1">{nutrients.kcal.toFixed(1)}</span>{" "}
        <span className="text-muted-foreground">kcal</span>
      </div>
      <div className="border-muted border px-2 py-1">
        <span className="text-chart-2 font-medium">PROTEIN:</span>{" "}
        <span className="text-chart-1">{nutrients.protein.toFixed(1)}</span>
        <span className="text-muted-foreground">g</span>
      </div>
    </div>
  );
}

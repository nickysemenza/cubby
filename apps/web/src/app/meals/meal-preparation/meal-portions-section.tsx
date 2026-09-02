import { Check, CircleAlert, Plus } from "lucide-react";

import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";

import {
  calorieText,
  measureText,
  type MealPreparation,
  type MealPreparationsView,
} from "./types";

export function MealPortionsSection({
  view,
  onAddPreparedPortion,
}: {
  view: MealPreparationsView;
  onAddPreparedPortion?: () => void;
}) {
  const hasPortions = view.preparations.some(
    (preparation) => preparation.portions.length > 0,
  );
  const hasPreparedSource = view.preparations.some(
    (preparation) => preparation.preparedHere,
  );

  return (
    <Stack gap="sm">
      <Row align="start" justify="between" gap="sm" wrap>
        <Stack gap={null}>
          <span className="text-sm font-semibold">Portions</span>
          <Description size="xs">
            Cost, calories, and protein are shown per recipe source; grams are
            never totaled across foods.
          </Description>
        </Stack>
        {onAddPreparedPortion ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onAddPreparedPortion}
          >
            <Plus className="size-4" />
            Add prepared portion
          </Button>
        ) : null}
      </Row>

      <div className="grid gap-2 sm:grid-cols-2">
        <SummaryStat
          label="Confirmed"
          totals={view.totals.confirmed}
          detail={`${view.totals.confirmed.portionCount} portion${view.totals.confirmed.portionCount === 1 ? "" : "s"}`}
        />
        <SummaryStat
          label="Projected"
          totals={view.totals.projected}
          detail={`${view.totals.projected.portionCount} portion${view.totals.projected.portionCount === 1 ? "" : "s"}`}
        />
      </div>

      {!hasPortions ? (
        <div className="border border-dashed border-[var(--border)] p-4">
          <Stack gap="xs">
            <span className="text-sm font-medium">
              {hasPreparedSource
                ? "No portions logged yet"
                : "No prepared portions yet"}
            </span>
            <Description size="xs">
              {hasPreparedSource
                ? "The batch is recorded. Add who ate it and the grams to project cost, calories, and protein."
                : "Record a cooked yield on a recipe row, then assign portions here or to another meal."}
            </Description>
          </Stack>
        </div>
      ) : (
        <Stack gap="md">
          {view.preparations.map((preparation) =>
            preparation.portions.length ? (
              <Stack key={preparation.mealRecipeId} gap="xs">
                <Row align="center" gap="sm">
                  <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {preparation.recipe.name}
                  </span>
                  <Badge variant="outline">
                    {preparation.actualYieldGrams == null
                      ? "Yield pending"
                      : `${preparation.actualYieldGrams} g made`}
                  </Badge>
                </Row>
                {preparation.sourceSummary ? (
                  <Description size="xs">
                    {preparation.sourceSummary.assignedGrams} g assigned ·{" "}
                    {preparation.sourceSummary.confirmedGrams} g confirmed
                    {preparation.sourceSummary.unassignedGrams == null
                      ? " · remaining unknown"
                      : preparation.sourceSummary.unassignedGrams < 0
                        ? ` · ${Math.abs(preparation.sourceSummary.unassignedGrams)} g over-assigned`
                        : ` · ${preparation.sourceSummary.unassignedGrams} g unassigned`}
                  </Description>
                ) : null}
                <Stack gap="xs">
                  {preparation.portions.map((portion) => (
                    <PortionLine
                      key={`${preparation.mealRecipeId}-${portion.targetMeal.id}-${portion.eater.id}`}
                      preparation={preparation}
                      portion={portion}
                    />
                  ))}
                </Stack>
              </Stack>
            ) : null,
          )}
        </Stack>
      )}
    </Stack>
  );
}

function PortionLine({
  preparation,
  portion,
}: {
  preparation: MealPreparation;
  portion: MealPreparation["portions"][number];
}) {
  const confirmed = portion.confirmedAt != null;
  return (
    <div className="border border-[var(--border)] bg-card px-3 py-2">
      <Row align="center" justify="between" gap="sm" wrap>
        <Stack gap={null} className="min-w-0 flex-1">
          <span className="truncate text-sm font-medium">
            {portion.eater.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {portion.targetMeal.name ?? portion.targetMeal.date}
            {portion.servedHere ? " · here" : " · assigned meal"}
          </span>
        </Stack>
        <Row align="center" gap="sm" className="shrink-0">
          <span className="text-sm tabular-nums">{portion.grams} g</span>
          <Badge variant={confirmed ? "positive" : "warning"}>
            {confirmed ? <Check className="size-3" /> : null}
            {confirmed ? "Confirmed" : "Planned"}
          </Badge>
        </Row>
      </Row>
      <Row align="start" gap="xs" className="mt-1" wrap>
        {[portion.cost, portion.calories, portion.protein].some(
          (estimate) =>
            estimate.status === "pending" || estimate.status === "unavailable",
        ) ? (
          <CircleAlert className="size-3 text-muted-foreground" />
        ) : null}
        <span className="text-2xs text-muted-foreground">
          Cost {measureText(portion.cost, "cost")} · Calories{" "}
          {calorieText(portion.calories)} · Protein{" "}
          {measureText(portion.protein, "protein")} from{" "}
          {preparation.recipe.name}
        </span>
      </Row>
    </div>
  );
}

function SummaryStat({
  label,
  totals,
  detail,
}: {
  label: string;
  totals: MealPreparationsView["totals"]["confirmed"];
  detail: string;
}) {
  return (
    <div className="border border-[var(--border)] bg-card px-3 py-2">
      <Row align="start" justify="between" gap="sm" wrap>
        <span className="text-xs text-muted-foreground">{label}</span>
        <Stack gap={null} className="text-right text-2xs text-muted-foreground">
          <span className="tabular-nums">
            Cost {measureText(totals.cost, "cost")}
          </span>
          <span className="tabular-nums">
            Calories {calorieText(totals.calories)}
          </span>
          <span className="tabular-nums">
            Protein {measureText(totals.protein, "protein")}
          </span>
        </Stack>
      </Row>
      <span className="text-2xs text-muted-foreground">{detail}</span>
    </div>
  );
}

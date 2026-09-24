import { PlusIcon as Plus } from "@phosphor-icons/react/dist/csr/Plus";

import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { formatEstimate } from "~/lib/nutrition-format";

import {
  formatFoodAmount,
  formatFoodAmountEstimate,
} from "../food-amount-editor";
import { type MealPreparation, type MealPreparationsView } from "./types";

export function MealPortionsSection({
  view,
  onAddPreparedPortion,
  onEditPreparation,
}: {
  view: MealPreparationsView;
  onAddPreparedPortion?: () => void;
  onEditPreparation?: (mealRecipeId: string) => void;
}) {
  const visiblePreparations = view.preparations.filter(
    (preparation) =>
      preparation.preparedHere || preparation.portions.length > 0,
  );

  return (
    <Stack gap="sm">
      <Row align="start" justify="between" gap="sm" wrap>
        <Description size="xs">
          Record cooked yields and assign portions in the unit you know. Each
          amount stays with the meal where it was served.
        </Description>
        {onAddPreparedPortion ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onAddPreparedPortion}
          >
            <Plus className="size-4" />
            Add leftovers
          </Button>
        ) : null}
      </Row>

      {visiblePreparations.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-4">
          <Stack gap="xs">
            <span className="text-sm font-medium">No recipe portions yet</span>
            <Description size="xs">
              Add a recipe or bring in leftovers, then record who had how many
              servings, grams, or another known amount.
            </Description>
          </Stack>
        </div>
      ) : (
        <div className="divide-y rounded-md border border-[var(--border)] bg-card">
          {visiblePreparations.map((preparation) => (
            <PreparationRow
              key={preparation.mealRecipeId}
              preparation={preparation}
              onEdit={
                onEditPreparation
                  ? () => onEditPreparation(preparation.mealRecipeId)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </Stack>
  );
}

function PreparationRow({
  preparation,
  onEdit,
}: {
  preparation: MealPreparation;
  onEdit?: () => void;
}) {
  const portionsHere = preparation.portions.filter(
    (portion) => portion.servedHere,
  );

  return (
    <div className="px-3 py-3">
      <Row align="start" justify="between" gap="sm">
        <Stack gap="xs" className="min-w-0">
          <Row align="center" gap="xs" wrap>
            <span className="truncate text-sm font-medium">
              {preparation.recipe.name}
            </span>
            <Badge variant="outline">{yieldLabel(preparation)}</Badge>
          </Row>
          {!preparation.preparedHere ? (
            <Description size="xs">
              From {preparation.sourceMeal.name ?? preparation.sourceMeal.date}
            </Description>
          ) : preparation.sourceSummary ? (
            <Description size="xs">
              {assignedAmountText(preparation)}
              {preparation.sourceSummary.unassignedGrams == null
                ? " · remainder unknown"
                : preparation.sourceSummary.unassignedGrams < 0
                  ? ` · ${Math.abs(preparation.sourceSummary.unassignedGrams)} g over assigned`
                  : ` · ${preparation.sourceSummary.unassignedGrams} g remaining`}
            </Description>
          ) : null}
          {portionsHere.length ? (
            <ul className="grid gap-1 text-xs text-muted-foreground">
              {portionsHere.map((portion) => (
                <li key={portion.eater.id}>
                  <span className="text-foreground">{portion.eater.name}</span>{" "}
                  {formatFoodAmount(portion.amount)} ·{" "}
                  {formatFoodAmountEstimate(portion)}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-xs text-muted-foreground">
              No one assigned yet
            </span>
          )}
        </Stack>
        {onEdit ? (
          <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
            Edit portions
          </Button>
        ) : null}
      </Row>
    </div>
  );
}

function assignedAmountText(preparation: MealPreparation): string {
  const summary = preparation.sourceSummary;
  if (!summary) return "";
  if (summary.assignedGrams != null)
    return `${Number(summary.assignedGrams.toFixed(1)).toLocaleString()} g assigned`;
  if (
    summary.assignedShare.status === "complete" ||
    summary.assignedShare.status === "partial"
  )
    return `${formatEstimate(summary.assignedShare, (value) => `${Number((value * 100).toFixed(1)).toLocaleString()}%`)} of batch assigned`;
  return "Assigned weight unknown";
}

function yieldLabel(preparation: MealPreparation): string {
  switch (preparation.yieldBasis.kind) {
    case "actual":
      return `${preparation.yieldBasis.lowerGrams} g made`;
    case "estimated":
      return `${preparation.yieldBasis.lowerGrams} g estimated`;
    case "recipe":
      return `${preparation.yieldBasis.lowerGrams} g recipe yield`;
    case "missing":
      return "Yield needed";
  }
}

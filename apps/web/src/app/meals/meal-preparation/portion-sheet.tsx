import type {
  MealFoodAmount,
  MealPreparationYieldBasis,
} from "@cubby/schemas/meal";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { format, parseISO } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";

import { StaticPicker } from "~/app/_components/combobox/static-picker";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { DialogFooter } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { calculateFoodAmount } from "~/lib/meal-food-nutrition";

import { FoodAmountEditor, formatFoodAmount } from "../food-amount-editor";
import { MealNutritionEstimates } from "../meal-nutrition";
import {
  mealLabel,
  type MealPreparation,
  type PreparationEaterOption,
  type PreparationSaveRequest,
  type PreparationTargetOption,
} from "./types";

type PortionDraft = {
  id: string;
  targetMealId: PreparationTargetOption["id"] | null;
  eaterId: PreparationEaterOption["id"] | null;
  amount: MealFoodAmount | null;
};

const portionKey = (targetMealId: string, eaterId: string) =>
  `${targetMealId}:${eaterId}`;

function isCompleteDraft(row: PortionDraft): row is PortionDraft & {
  targetMealId: NonNullable<PortionDraft["targetMealId"]>;
  eaterId: NonNullable<PortionDraft["eaterId"]>;
} {
  return row.targetMealId != null && row.eaterId != null;
}

function draftIsValid(row: PortionDraft): boolean {
  return isCompleteDraft(row) && row.amount != null;
}

function hasDuplicateDraft(rows: PortionDraft[]): boolean {
  const keys = rows
    .filter(isCompleteDraft)
    .map((row) => portionKey(row.targetMealId, row.eaterId));
  return new Set(keys).size !== keys.length;
}

function removeCommand(
  portion: MealPreparation["portions"][number],
): PreparationSaveRequest["changes"][number] {
  return {
    action: "remove",
    mealId: portion.targetMeal.id,
    ledgerPartyId: portion.eater.id,
  };
}

function setCommand(
  row: PortionDraft & {
    targetMealId: NonNullable<PortionDraft["targetMealId"]>;
    eaterId: NonNullable<PortionDraft["eaterId"]>;
  },
): PreparationSaveRequest["changes"][number] {
  return {
    action: "set",
    mealId: row.targetMealId,
    ledgerPartyId: row.eaterId,
    amount: row.amount!,
    // The redesigned editor records an entered amount directly. The legacy
    // confirmation field stays in the wire contract, but is no longer a UI
    // state people have to manage.
    confirmed: true,
  };
}

export function PortionSheet({
  source,
  currentMealId,
  targetMeals,
  eaters,
  open,
  onOpenChange,
  onSave,
  isSaving = false,
}: {
  source: MealPreparation;
  currentMealId: PreparationTargetOption["id"];
  targetMeals: PreparationTargetOption[];
  eaters: PreparationEaterOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (request: PreparationSaveRequest) => void | Promise<void>;
  isSaving?: boolean;
}) {
  const firstTarget =
    targetMeals.find((meal) => meal.id === currentMealId)?.id ??
    targetMeals[0]?.id ??
    null;
  const firstEater = eaters[0]?.id ?? null;
  const draftSequence = useRef(0);
  const newDraft = (): PortionDraft => ({
    id: `${source.mealRecipeId}:draft:${draftSequence.current++}`,
    targetMealId: firstTarget,
    eaterId: firstEater,
    amount: null,
  });
  const [expectedYield, setExpectedYield] = useState(
    source.estimatedYieldGrams == null
      ? ""
      : String(source.estimatedYieldGrams),
  );
  const [actualYield, setActualYield] = useState(
    source.actualYieldGrams == null ? "" : String(source.actualYieldGrams),
  );
  const [rows, setRows] = useState<PortionDraft[]>(() =>
    source.portions.length
      ? source.portions.map((portion) => ({
          id: portionKey(portion.targetMeal.id, portion.eater.id),
          targetMealId: portion.targetMeal.id,
          eaterId: portion.eater.id,
          amount: portion.amount,
        }))
      : [newDraft()],
  );

  useEffect(() => {
    setRows((current) =>
      current.map((row) => ({
        ...row,
        targetMealId: row.targetMealId ?? firstTarget,
        eaterId: row.eaterId ?? firstEater,
      })),
    );
  }, [firstEater, firstTarget]);

  const yieldNumber = Number(actualYield);
  const yieldIsValid =
    actualYield === "" || (yieldNumber > 0 && Number.isInteger(yieldNumber));
  const expectedNumber = Number(expectedYield);
  const expectedIsValid =
    expectedYield === "" ||
    (expectedNumber > 0 && Number.isInteger(expectedNumber));
  const hasInvalidPortion = rows.some((row) => !draftIsValid(row));
  const hasDuplicatePortion = hasDuplicateDraft(rows);
  const canSave =
    yieldIsValid &&
    expectedIsValid &&
    !hasInvalidPortion &&
    !hasDuplicatePortion &&
    !isSaving;

  const sourceDate = useMemo(() => {
    const date = parseISO(source.sourceMeal.date);
    return Number.isNaN(date.valueOf())
      ? source.sourceMeal.date
      : format(date, "MMM d");
  }, [source.sourceMeal.date]);

  const updateRow = (index: number, patch: Partial<PortionDraft>) => {
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );
  };

  const submit = () => {
    if (!canSave) return;
    const currentKeys = new Set(
      rows
        .filter(isCompleteDraft)
        .map((row) => portionKey(row.targetMealId, row.eaterId)),
    );
    const removed = source.portions
      .filter(
        (portion) =>
          !currentKeys.has(portionKey(portion.targetMeal.id, portion.eater.id)),
      )
      .map(removeCommand);

    const changed = rows.filter(isCompleteDraft).flatMap((row) => {
      const original = source.portions.find(
        (portion) =>
          portion.targetMeal.id === row.targetMealId &&
          portion.eater.id === row.eaterId,
      );
      return original && amountsEqual(original.amount, row.amount)
        ? []
        : [setCommand(row)];
    });

    void onSave({
      mealRecipeId: source.mealRecipeId,
      estimatedYieldGrams: expectedYield === "" ? null : expectedNumber,
      actualYieldGrams: actualYield === "" ? null : yieldNumber,
      changes: [...removed, ...changed],
    });
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`Portions · ${source.recipe.name}`}
      description={`Prepared ${sourceDate} · ${source.preparedHere ? "cooked here" : "from another meal"}`}
      footer={
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={!canSave} onClick={submit}>
            <CheckIcon className="size-4" />
            {isSaving ? "Saving…" : "Save portions"}
          </Button>
        </DialogFooter>
      }
    >
      <Stack gap="lg">
        <YieldFields
          source={source}
          expectedYield={expectedYield}
          actualYield={actualYield}
          expectedNumber={expectedNumber}
          actualNumber={yieldNumber}
          expectedIsValid={expectedIsValid}
          actualIsValid={yieldIsValid}
          onExpectedChange={setExpectedYield}
          onActualChange={setActualYield}
        />
        <PeopleFields
          source={source}
          currentMealId={currentMealId}
          rows={rows}
          eaters={eaters}
          targetMeals={targetMeals}
          onAdd={() => setRows((current) => [...current, newDraft()])}
          onRemove={(index) =>
            setRows((current) =>
              current.filter((_, rowIndex) => rowIndex !== index),
            )
          }
          onUpdate={updateRow}
        />
      </Stack>
    </ResponsiveDialog>
  );
}

function YieldFields({
  source,
  expectedYield,
  actualYield,
  expectedNumber,
  actualNumber,
  expectedIsValid,
  actualIsValid,
  onExpectedChange,
  onActualChange,
}: {
  source: MealPreparation;
  expectedYield: string;
  actualYield: string;
  expectedNumber: number;
  actualNumber: number;
  expectedIsValid: boolean;
  actualIsValid: boolean;
  onExpectedChange: (value: string) => void;
  onActualChange: (value: string) => void;
}) {
  return (
    <Stack gap="sm">
      <Row align="center" justify="between" gap="sm">
        <Stack gap={null}>
          <span className="text-sm font-medium">Yield</span>
          <Description size="xs">
            Measure the cooked batch once; cost and nutrition stay tied to this
            recipe occurrence.
          </Description>
        </Stack>
      </Row>
      <div className="grid grid-cols-2 gap-3">
        <Stack gap="xs">
          <Label htmlFor={`${source.mealRecipeId}-expected`}>
            Expected (g)
          </Label>
          <Input
            id={`${source.mealRecipeId}-expected`}
            type="number"
            min={1}
            inputMode="decimal"
            className="h-11 tabular-nums"
            value={expectedYield}
            onChange={(event) => onExpectedChange(event.target.value)}
            aria-invalid={!expectedIsValid}
          />
        </Stack>
        <Stack gap="xs">
          <Label htmlFor={`${source.mealRecipeId}-actual`}>Made (g)</Label>
          <Input
            id={`${source.mealRecipeId}-actual`}
            type="number"
            min={1}
            inputMode="decimal"
            className="h-11 tabular-nums"
            placeholder="After cooking"
            value={actualYield}
            onChange={(event) => onActualChange(event.target.value)}
            aria-invalid={!actualIsValid}
          />
        </Stack>
      </div>
      {expectedYield !== "" &&
      actualYield !== "" &&
      actualIsValid &&
      expectedIsValid ? (
        <Description size="xs">
          Made {actualYield} g vs {expectedYield} g estimated
          {actualNumber === expectedNumber
            ? " · on estimate"
            : ` · ${Math.abs(actualNumber - expectedNumber)} g ${actualNumber > expectedNumber ? "over" : "under"}`}
        </Description>
      ) : null}
      <Description size="xs">
        {source.actualYieldGrams == null && actualYield === ""
          ? "Made yield unlocks per-gram cost and nutrition estimates."
          : `Basis: ${yieldBasisLabel(source.yieldBasis)}.`}
      </Description>
      {(source.recipeServings || source.recipeYield) && (
        <Description size="xs">
          Recipe declares{" "}
          {[
            source.recipeServings
              ? `${source.recipeServings} serving${source.recipeServings === 1 ? "" : "s"}`
              : null,
            source.recipeYield ? formatFoodAmount(source.recipeYield) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          .
        </Description>
      )}
      <details className="text-xs">
        <summary className="min-h-10 cursor-pointer content-center text-muted-foreground hover:text-foreground">
          Recipe nutrition details
        </summary>
        <div className="border-t pt-2">
          <MealNutritionEstimates totals={source.totals} />
        </div>
      </details>
    </Stack>
  );
}

function PeopleFields({
  source,
  currentMealId,
  rows,
  eaters,
  targetMeals,
  onAdd,
  onRemove,
  onUpdate,
}: {
  source: MealPreparation;
  currentMealId: PreparationTargetOption["id"];
  rows: PortionDraft[];
  eaters: PreparationEaterOption[];
  targetMeals: PreparationTargetOption[];
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, patch: Partial<PortionDraft>) => void;
}) {
  const indexedRows = rows.map((row, index) => ({ row, index }));
  const currentRows = indexedRows.filter(
    ({ row }) => row.targetMealId === currentMealId,
  );
  const otherRows = indexedRows.filter(
    ({ row }) => row.targetMealId !== currentMealId,
  );
  const renderRow = ({ row, index }: (typeof indexedRows)[number]) => (
    <PortionDraftRow
      key={row.id}
      source={source}
      row={row}
      index={index}
      eaters={eaters}
      targetMeals={targetMeals}
      canRemove={rows.length > 1 || source.portions.length > 0}
      onRemove={() => onRemove(index)}
      onUpdate={(patch) => onUpdate(index, patch)}
    />
  );

  return (
    <Stack gap="sm">
      <Row align="center" justify="between">
        <Stack gap={null}>
          <span className="text-sm font-medium">Who ate how much?</span>
          <Description size="xs">
            Enter the amount for this meal. Portions saved to another meal stay
            with that meal's date.
          </Description>
        </Stack>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <PlusIcon className="size-4" />
          Add person
        </Button>
      </Row>
      <Stack gap="sm">
        {currentRows.map(renderRow)}
        {otherRows.length ? (
          <details className="rounded-md border border-[var(--border)] bg-[var(--muted)]/35 px-3 py-2">
            <summary className="min-h-10 cursor-pointer content-center text-sm font-medium">
              Other meals · {otherRows.length}
            </summary>
            <Stack gap="sm" className="pt-2">
              {otherRows.map(renderRow)}
            </Stack>
          </details>
        ) : null}
      </Stack>
    </Stack>
  );
}

function PortionDraftRow({
  source,
  row,
  index,
  eaters,
  targetMeals,
  canRemove,
  onRemove,
  onUpdate,
}: {
  source: MealPreparation;
  row: PortionDraft;
  index: number;
  eaters: PreparationEaterOption[];
  targetMeals: PreparationTargetOption[];
  canRemove: boolean;
  onRemove: () => void;
  onUpdate: (patch: Partial<PortionDraft>) => void;
}) {
  const suggestedUnits = useMemo(
    () => (source.recipeYield ? [source.recipeYield.unit] : []),
    [source.recipeYield],
  );
  return (
    <div className="space-y-2 border border-[var(--border)] bg-card p-3">
      <Row align="center" justify="between" gap="sm">
        <span className="text-xs font-medium text-muted-foreground">
          Person {index + 1}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove person ${index + 1}`}
          onClick={onRemove}
          disabled={!canRemove}
        >
          <TrashIcon className="size-4" />
        </Button>
      </Row>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_minmax(11rem,0.9fr)]">
        <StaticPicker
          items={eaters.map((eater) => ({
            value: eater.id,
            label: eater.name,
          }))}
          value={row.eaterId}
          onValueChange={(value) =>
            onUpdate({
              eaterId: eaters.find((eater) => eater.id === value)?.id ?? null,
            })
          }
          label="Eater"
          placeholder="Choose person"
          className="min-w-0"
        />
        <StaticPicker
          items={targetMeals.map((meal) => ({
            value: meal.id,
            label: mealLabel(meal),
          }))}
          value={row.targetMealId}
          onValueChange={(value) =>
            onUpdate({
              targetMealId:
                targetMeals.find((meal) => meal.id === value)?.id ?? null,
            })
          }
          label="Meal"
          placeholder="Choose meal"
          className="min-w-0"
        />
        <FoodAmountEditor
          id={`${source.mealRecipeId}-amount-${index}`}
          amount={row.amount}
          onChange={(amount) => onUpdate({ amount })}
          sourceKind="recipe"
          suggestedUnits={suggestedUnits}
          estimate={
            row.amount
              ? calculateFoodAmount(row.amount, {
                  kind: "recipe",
                  batch: source.totals,
                  yieldBasis: source.yieldBasis,
                  recipeYield: source.recipeYield,
                  servings: source.recipeServings,
                  scale: source.scale,
                })
              : null
          }
        />
      </div>
    </div>
  );
}

function amountsEqual(
  first: MealFoodAmount,
  second: MealFoodAmount | null,
): boolean {
  return (
    second != null && first.value === second.value && first.unit === second.unit
  );
}

function yieldBasisLabel(basis: MealPreparationYieldBasis): string {
  const labels = {
    actual: "actual measured yield",
    estimated: "estimated mass yield",
    recipe: "recipe mass yield",
    missing: "no mass yield recorded",
  } as const;
  return labels[basis.kind];
}

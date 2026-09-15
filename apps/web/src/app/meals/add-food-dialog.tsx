import {
  type IngredientShortcode,
  type LedgerPartyShortcode,
  type MealShortcode,
  type ProductShortcode,
  type RecipeShortcode,
} from "@cubby/schemas/identifiers";
import {
  saveMealFoodInput,
  type MealNutritionFood,
  type MealFoodNutrients,
} from "@cubby/schemas/meal";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import { ledgerParty } from "~/app/finance/finance.functions";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { getErrorMessage } from "~/lib/error-utils";
import { calculateFoodAmount } from "~/lib/meal-food-nutrition";
import {
  getAllUnitMappingsFromProduct,
  getIngredientMappings,
} from "~/lib/unit-mapping-utils";

import { FoodAmountEditor } from "./food-amount-editor";
import { meal } from "./meal.functions";

const MACRO_FIELDS = [
  { key: "kcal", label: "Calories (kcal)" },
  { key: "protein", label: "Protein (g)" },
  { key: "carbs", label: "Carbs (g)" },
  { key: "fat", label: "Fat (g)" },
] as const;
const NO_SUGGESTED_UNITS: string[] = [];
type EditableFood = Exclude<MealNutritionFood, { sourceKind: "recipe" }>;
type FoodKind = EditableFood["sourceKind"] | "recipe";

export function AddFoodDialog(props: {
  mealId: MealShortcode;
  date: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecipe?: (recipeId: RecipeShortcode) => void;
  editing?: { food: EditableFood; eaterId: LedgerPartyShortcode };
}) {
  return props.open ? (
    <FoodEntryForm key={props.editing?.food.id ?? props.mealId} {...props} />
  ) : null;
}

function FoodEntryForm({
  mealId,
  date,
  onOpenChange,
  onRecipe,
  editing,
}: Parameters<typeof AddFoodDialog>[0]) {
  const draft = useFoodDraft(editing);
  const {
    original,
    kind,
    setKind,
    eaterId,
    setEaterId,
    productItem,
    ingredientItem,
    amount,
    name,
    nutrients,
  } = draft;
  const [error, setError] = useState<string | null>(null);
  const eaters = useQuery(ledgerParty.options.queryOptions(null));
  const options = eaters.data?.filter((p) => p.kind !== "household");
  const selectedEater =
    eaterId == null ? options?.[0] : options?.find((p) => p.id === eaterId);
  const calculation = useFoodAmount(draft);
  const save = useMutation(
    meal.saveFood.mutationOptions({
      onSuccess: () => {
        toast.success(editing ? "Food updated" : "Food added");
        onOpenChange(false);
      },
      onError: (cause) => setError(getErrorMessage(cause)),
    }),
  );
  const submit = () => {
    if (!draft.amountIsValid) {
      setError(
        kind === "manual"
          ? "Enter a valid serving amount or leave it blank."
          : "Enter a valid food amount.",
      );
      return;
    }
    const common = {
      id: original?.id,
      mealId,
      ledgerPartyId: selectedEater?.id,
    };
    const data =
      kind === "product"
        ? {
            ...common,
            sourceKind: kind,
            productId: productItem?.id,
            amount,
          }
        : kind === "ingredient"
          ? {
              ...common,
              sourceKind: kind,
              ingredientId: ingredientItem?.id,
              amount,
            }
          : {
              ...common,
              sourceKind: "manual",
              name,
              amount,
              nutrients: draftNutrients(original, nutrients),
            };
    const parsed = saveMealFoodInput.safeParse(data);
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Check the food amount and person.",
      );
      return;
    }
    setError(null);
    save.mutate(parsed.data);
  };
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!save.isPending) onOpenChange(open);
      }}
      title={editing ? "Edit food" : "Add food"}
      description={`For ${date}`}
      footer={
        kind !== "recipe" ? (
          <Row justify="end" gap="sm">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={save.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              disabled={
                save.isPending ||
                !selectedEater ||
                (kind === "product" && !productItem) ||
                (kind === "ingredient" && !ingredientItem)
              }
              onClick={submit}
            >
              {save.isPending
                ? "Saving…"
                : editing
                  ? "Save changes"
                  : "Add food"}
            </Button>
          </Row>
        ) : undefined
      }
    >
      <Stack gap="lg">
        {!editing && (
          <Row gap="sm" aria-label="Food source">
            {(["product", "ingredient", "recipe", "manual"] as const)
              .filter((source) => source !== "recipe" || onRecipe)
              .map((source) => (
                <Button
                  key={source}
                  className="min-h-11 flex-1"
                  variant={kind === source ? "default" : "outline"}
                  aria-pressed={kind === source}
                  onClick={() => {
                    setKind(source);
                    draft.setAmountIsValid(
                      draft.amount != null || source === "manual",
                    );
                    setError(null);
                  }}
                >
                  {source === "product"
                    ? "Product"
                    : source === "ingredient"
                      ? "Ingredient"
                      : source === "recipe"
                        ? "Recipe"
                        : "Manual"}
                </Button>
              ))}
          </Row>
        )}
        {kind === "recipe" ? (
          <WithEntitySearch entity="recipe">
            {(search) => (
              <EntityPicker<RecipeShortcode>
                {...search}
                entity="recipe"
                value={null}
                setValue={(item) => {
                  if (item) onRecipe?.(item.id);
                }}
                label="Recipe"
                placeholder="Find a recipe"
              />
            )}
          </WithEntitySearch>
        ) : (
          <>
            <EntityPicker<LedgerPartyShortcode>
              entity="ledgerParty"
              label="Person"
              items={options ?? []}
              value={selectedEater ?? null}
              setValue={(item) => setEaterId(item?.id ?? null)}
              isLoading={eaters.isLoading}
              error={eaters.error ? getErrorMessage(eaters.error) : null}
              clearable={false}
            />
            {kind === "product" ? (
              <ProductFields draft={draft} calculation={calculation} />
            ) : kind === "ingredient" ? (
              <IngredientFields draft={draft} calculation={calculation} />
            ) : (
              <ManualFields draft={draft} calculation={calculation} />
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </Stack>
    </ResponsiveDialog>
  );
}

function useFoodDraft(editing: Parameters<typeof AddFoodDialog>[0]["editing"]) {
  const original = editing?.food;
  const [kind, setKind] = useState<FoodKind>(original?.sourceKind ?? "product");
  const [productItem, setProductItem] =
    useState<ComboboxItem<ProductShortcode> | null>(
      original?.sourceKind === "product"
        ? { id: original.productId, name: original.name }
        : null,
    );
  const [ingredientItem, setIngredientItem] =
    useState<ComboboxItem<IngredientShortcode> | null>(
      original?.sourceKind === "ingredient"
        ? { id: original.ingredientId, name: original.name }
        : null,
    );
  const [eaterId, setEaterId] = useState<LedgerPartyShortcode | null>(
    editing?.eaterId ?? null,
  );
  const [amount, setAmount] = useState(
    original?.amount ??
      (original?.grams == null
        ? null
        : { value: original.grams, unit: "g" as const }),
  );
  const [amountIsValid, setAmountIsValid] = useState(
    original?.amount != null ||
      original?.grams != null ||
      original?.sourceKind === "manual",
  );
  const [name, setName] = useState(original?.name ?? "");
  const [nutrients, setNutrients] = useState<
    Partial<Record<(typeof MACRO_FIELDS)[number]["key"], string>>
  >(
    Object.fromEntries(
      MACRO_FIELDS.map(({ key }) => [
        key,
        original?.sourceKind === "manual"
          ? (original.nutrients[key]?.toString() ?? "")
          : "",
      ]),
    ),
  );

  return {
    original,
    kind,
    setKind,
    productItem,
    setProductItem,
    ingredientItem,
    setIngredientItem,
    eaterId,
    setEaterId,
    amount,
    setAmount,
    amountIsValid,
    setAmountIsValid,
    name,
    setName,
    nutrients,
    setNutrients,
  };
}
function sourceUnits(
  mappings: Array<{ a: { unit: string }; b: { unit: string } }>,
): string[] {
  const nutrientUnit = /^(g|mg|ug|µg|mcg|iu|kj)\s+\S/i;
  return [
    ...new Set(
      mappings
        .flatMap((mapping) => [mapping.a.unit, mapping.b.unit])
        .filter(
          (unit) =>
            unit !== "dollar" && unit !== "kcal" && !nutrientUnit.test(unit),
        ),
    ),
  ];
}

function useFoodAmount(draft: ReturnType<typeof useFoodDraft>) {
  const product = useQuery(
    entityDetailFor("product").queryOptions(draft.productItem?.id ?? "", {
      enabled: draft.kind === "product" && draft.productItem != null,
    }),
  );
  const ingredient = useQuery(
    entityDetailFor("ingredient").queryOptions(draft.ingredientItem?.id ?? "", {
      enabled: draft.kind === "ingredient" && draft.ingredientItem != null,
    }),
  );
  const source = useMemo(
    () =>
      draft.kind === "product" && product.data
        ? ({ kind: "product", product: product.data } as const)
        : draft.kind === "ingredient" && ingredient.data
          ? ({ kind: "ingredient", ingredient: ingredient.data } as const)
          : draft.kind === "manual"
            ? ({
                kind: "manual",
                nutrients: draftNutrients(draft.original, draft.nutrients),
              } as const)
            : null,
    [
      draft.kind,
      draft.nutrients,
      draft.original,
      ingredient.data,
      product.data,
    ],
  );
  const estimate =
    draft.amount && source ? calculateFoodAmount(draft.amount, source) : null;
  const suggestedUnits = useMemo(
    () =>
      product.data
        ? sourceUnits(getAllUnitMappingsFromProduct(product.data))
        : ingredient.data
          ? sourceUnits(getIngredientMappings(ingredient.data))
          : NO_SUGGESTED_UNITS,
    [ingredient.data, product.data],
  );

  return { product, ingredient, estimate, suggestedUnits };
}
function draftNutrients(
  original: EditableFood | undefined,
  values: ReturnType<typeof useFoodDraft>["nutrients"],
): MealFoodNutrients {
  let result: MealFoodNutrients = {};
  if (original?.sourceKind === "manual") result = { ...original.nutrients };
  for (const { key } of MACRO_FIELDS) {
    const text = values[key];
    if (text?.trim()) result[key] = Number(text);
    else delete result[key];
  }
  return result;
}
function FoodField({
  label,
  value,
  onChange,
  numeric = true,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="grid gap-2 text-sm">
      <label htmlFor={id}>{label}</label>
      <Input
        id={id}
        className="min-h-11"
        type={numeric ? "number" : "text"}
        inputMode={numeric ? "decimal" : "text"}
        min={numeric ? "0" : undefined}
        step={numeric ? "any" : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
function ProductFields({
  draft,
  calculation,
}: {
  draft: ReturnType<typeof useFoodDraft>;
  calculation: ReturnType<typeof useFoodAmount>;
}) {
  const { product, estimate, suggestedUnits } = calculation;
  return (
    <>
      <WithEntitySearch entity="product">
        {(search) => (
          <EntityPicker<ProductShortcode>
            {...search}
            entity="product"
            value={draft.productItem}
            setValue={draft.setProductItem}
            label="Product"
            placeholder="Find a packaged food"
          />
        )}
      </WithEntitySearch>
      {product.error && (
        <p role="alert" className="text-sm text-destructive">
          {getErrorMessage(product.error)}
        </p>
      )}
      <FoodAmountEditor
        amount={draft.amount}
        onChange={draft.setAmount}
        onValidityChange={draft.setAmountIsValid}
        sourceKind="product"
        suggestedUnits={suggestedUnits}
        estimate={estimate}
      />
    </>
  );
}

function IngredientFields({
  draft,
  calculation,
}: {
  draft: ReturnType<typeof useFoodDraft>;
  calculation: ReturnType<typeof useFoodAmount>;
}) {
  return (
    <>
      <WithEntitySearch entity="ingredient">
        {(search) => (
          <EntityPicker<IngredientShortcode>
            {...search}
            entity="ingredient"
            value={draft.ingredientItem}
            setValue={draft.setIngredientItem}
            label="Ingredient"
            placeholder="Find an ingredient"
          />
        )}
      </WithEntitySearch>
      {calculation.ingredient.error && (
        <p role="alert" className="text-sm text-destructive">
          {getErrorMessage(calculation.ingredient.error)}
        </p>
      )}
      <FoodAmountEditor
        amount={draft.amount}
        onChange={draft.setAmount}
        onValidityChange={draft.setAmountIsValid}
        sourceKind="ingredient"
        suggestedUnits={calculation.suggestedUnits}
        estimate={calculation.estimate}
      />
    </>
  );
}

function ManualFields({
  draft,
  calculation,
}: {
  draft: ReturnType<typeof useFoodDraft>;
  calculation: ReturnType<typeof useFoodAmount>;
}) {
  return (
    <>
      <FoodField
        label="Food name"
        numeric={false}
        value={draft.name}
        onChange={draft.setName}
        placeholder="e.g. Yogurt with fruit"
      />
      <FoodAmountEditor
        amount={draft.amount}
        onChange={draft.setAmount}
        onValidityChange={draft.setAmountIsValid}
        sourceKind="manual"
        estimate={calculation.estimate}
        label="Serving amount"
        required={false}
      />
      <p className="text-sm text-muted-foreground">
        Macros for this entered serving. Leave unknown values blank.
      </p>
      <div className="grid grid-cols-2 gap-4">
        {MACRO_FIELDS.map(({ key, label }) => (
          <FoodField
            key={key}
            label={label}
            value={draft.nutrients[key] ?? ""}
            onChange={(value) =>
              draft.setNutrients((current) => ({ ...current, [key]: value }))
            }
          />
        ))}
      </div>
    </>
  );
}

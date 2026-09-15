import {
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
import { useId, useState } from "react";
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
import { productServingGrams } from "~/lib/meal-food-nutrition";

import { meal } from "./meal.functions";

const MACRO_FIELDS = [
  { key: "kcal", label: "Calories (kcal)" },
  { key: "protein", label: "Protein (g)" },
  { key: "carbs", label: "Carbs (g)" },
  { key: "fat", label: "Fat (g)" },
] as const;
type EditableFood = Exclude<MealNutritionFood, { sourceKind: "recipe" }>;

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
    amount,
    name,
    nutrients,
  } = draft;
  const [error, setError] = useState<string | null>(null);
  const eaters = useQuery(ledgerParty.options.queryOptions(null));
  const options = eaters.data?.filter((p) => p.kind !== "household");
  const selectedEater =
    eaterId == null ? options?.[0] : options?.find((p) => p.id === eaterId);
  const calculation = useProductAmount(draft);
  const { product, grams } = calculation;
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
    const common = {
      id: original?.id,
      mealId,
      ledgerPartyId: selectedEater?.id,
    };
    const data =
      kind === "product"
        ? { ...common, sourceKind: kind, productId: productItem?.id, grams }
        : {
            ...common,
            sourceKind: "manual",
            name,
            grams: amount.trim() ? Number(amount) : null,
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
                (kind === "product" && (!product.data || product.isFetching))
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
            {(["product", "recipe", "manual"] as const)
              .filter((source) => source !== "recipe" || onRecipe)
              .map((source) => (
                <Button
                  key={source}
                  className="min-h-11 flex-1"
                  variant={kind === source ? "default" : "outline"}
                  aria-pressed={kind === source}
                  onClick={() => {
                    setKind(source);
                    setError(null);
                  }}
                >
                  {source === "product"
                    ? "Product"
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
            ) : (
              <ManualFields draft={draft} />
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
  const [kind, setKind] = useState<"product" | "manual" | "recipe">(
    original?.sourceKind ?? "product",
  );
  const [productItem, setProductItem] =
    useState<ComboboxItem<ProductShortcode> | null>(
      original?.sourceKind === "product"
        ? { id: original.productId, name: original.name }
        : null,
    );
  const [eaterId, setEaterId] = useState<LedgerPartyShortcode | null>(
    editing?.eaterId ?? null,
  );
  const [unit, setUnit] = useState<"grams" | "servings">("grams");
  const [amount, setAmount] = useState(original?.grams?.toString() ?? "");
  const [packageGrams, setPackageGrams] = useState("");
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
    eaterId,
    setEaterId,
    unit,
    setUnit,
    amount,
    setAmount,
    packageGrams,
    setPackageGrams,
    name,
    setName,
    nutrients,
    setNutrients,
  };
}
function useProductAmount(draft: ReturnType<typeof useFoodDraft>) {
  const product = useQuery(
    entityDetailFor("product").queryOptions(draft.productItem?.id ?? "", {
      enabled: draft.kind === "product" && draft.productItem != null,
    }),
  );
  const knownServingGrams = product.data
    ? productServingGrams(product.data)
    : null;
  const servingGrams = knownServingGrams ?? Number(draft.packageGrams);
  const grams =
    draft.unit === "servings"
      ? Number(draft.amount) * servingGrams
      : Number(draft.amount);

  return { product, knownServingGrams, servingGrams, grams };
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
  calculation: ReturnType<typeof useProductAmount>;
}) {
  const { product, knownServingGrams, servingGrams, grams } = calculation;
  return (
    <>
      <WithEntitySearch entity="product">
        {(search) => (
          <EntityPicker<ProductShortcode>
            {...search}
            entity="product"
            value={draft.productItem}
            setValue={(item) => {
              draft.setProductItem(item);
              draft.setPackageGrams("");
            }}
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
      <Row gap="sm">
        {(["grams", "servings"] as const).map((option) => (
          <Button
            key={option}
            variant={draft.unit === option ? "default" : "outline"}
            className="min-h-11 flex-1"
            aria-pressed={draft.unit === option}
            onClick={() => {
              draft.setUnit(option);
              draft.setAmount("");
            }}
          >
            {option === "grams" ? "Grams" : "Servings"}
          </Button>
        ))}
      </Row>
      <FoodField
        label={draft.unit === "grams" ? "Amount (g)" : "Number of servings"}
        value={draft.amount}
        onChange={draft.setAmount}
      />
      {draft.unit === "servings" && (
        <>
          {knownServingGrams == null && (
            <FoodField
              label="Grams per serving on the package"
              value={draft.packageGrams}
              onChange={draft.setPackageGrams}
            />
          )}
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {servingGrams > 0
              ? `1 serving = ${servingGrams.toLocaleString()} g${grams > 0 ? ` · Recording ${Number(grams.toFixed(2)).toLocaleString()} g` : ""}`
              : "Enter the serving weight printed on the package."}
          </p>
        </>
      )}
    </>
  );
}
function ManualFields({ draft }: { draft: ReturnType<typeof useFoodDraft> }) {
  return (
    <>
      <FoodField
        label="Food name"
        numeric={false}
        value={draft.name}
        onChange={draft.setName}
        placeholder="e.g. Yogurt with fruit"
      />
      <p className="text-sm text-muted-foreground">
        Macros for this person’s amount. Leave unknown values blank.
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
      <FoodField
        label="Weight (g, optional)"
        value={draft.amount}
        onChange={draft.setAmount}
      />
    </>
  );
}

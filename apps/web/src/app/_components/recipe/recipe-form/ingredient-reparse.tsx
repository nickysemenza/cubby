import type { Amount } from "@cubby/schemas/codec";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";

import { showErrorToast } from "~/components/feedback/error-details";
import { Button } from "~/components/ui/button";
import { computeParseDrift, hasDrift } from "~/lib/parse-drift";
import { wasm } from "~/lib/wasm";

import { formatAmounts } from "../../inventory/format-amount";
import { DriftIndicator } from "../../parse-drift-indicator";
import { useResolveIngredientName } from "../use-resolve-ingredient-names";
import type { IngItem, RecipeFormValues } from "./types";

/**
 * Per-row provenance + "re-parse this line" action in the recipe editor. Shows the
 * original import line (read-only), and when re-parsing it with the *current* parser
 * would change the row on any axis (name, amounts, or modifier), shows the per-axis
 * diff and a button to apply that fresh parse to the form row. The user still saves the
 * form to persist; this only restages the row.
 */
export function IngredientReparse({
  form,
  sectionIndex,
  ingredientIndex,
  onApply,
}: {
  form: UseFormReturn<RecipeFormValues>;
  sectionIndex: number;
  ingredientIndex: number;
  // Replace the whole row via the parent field array's `update`, so the nested
  // amounts field array re-mounts with the fresh values (setValue on a field-array
  // path doesn't re-sync useFieldArray).
  onApply: (row: IngItem) => void;
}) {
  const { resolveName } = useResolveIngredientName();
  const [applying, setApplying] = useState(false);

  const rawLine = form.watch(
    `sections.${sectionIndex}.ingredients.${ingredientIndex}.rawLine`,
  );
  const type = form.watch(
    `sections.${sectionIndex}.ingredients.${ingredientIndex}.type`,
  );
  const currentName = form.watch(
    `sections.${sectionIndex}.ingredients.${ingredientIndex}.ingredient.name`,
  );
  const aliases = form.watch(
    `sections.${sectionIndex}.ingredients.${ingredientIndex}.aliases`,
  );
  const amounts = form.watch(
    `sections.${sectionIndex}.ingredients.${ingredientIndex}.amounts`,
  );
  const modifier = form.watch(
    `sections.${sectionIndex}.ingredients.${ingredientIndex}.modifier`,
  );

  // Only plain ingredient rows that carry an original line can be re-parsed.
  if (type !== "ingredient" || !rawLine) return null;

  const fresh = wasm.parse_ingredient(rawLine);
  // Project the draft amounts to the persisted Amount shape (drop half-typed
  // rows), matching exactly what the apply/import path stores — including the
  // range upper bound so a ranged row doesn't read as perpetual drift.
  const persistedAmounts: Amount[] = (amounts ?? []).flatMap((a) => {
    if (a.value == null || !a.unit?.trim()) return [];
    const amount: Amount = { value: a.value, unit: a.unit };
    if (a.upperValue != null) amount.upperValue = a.upperValue;
    return [amount];
  });
  // Real drift only if the parse differs from what the row holds. The known-names set
  // (current name + aliases) keeps an alias hit from reading as a false positive.
  const drift = computeParseDrift(
    {
      knownNames: [currentName ?? "", ...(aliases ?? [])],
      amounts: persistedAmounts,
      modifier: modifier ?? null,
    },
    fresh,
  );
  const drifted = hasDrift(drift);

  const apply = async () => {
    setApplying(true);
    try {
      // Server-side find-or-create, so the row points at a real ingredient id.
      // Not a cached getByName + create: that lookup can report "missing" for a
      // name the import path created moments ago, and the create then fails on
      // the lower(name) unique index.
      const resolved = await resolveName(fresh.name);

      const current = form.getValues(
        `sections.${sectionIndex}.ingredients.${ingredientIndex}`,
      );
      // Replace the whole row so the nested amounts field array re-mounts.
      onApply({
        ...current,
        type: "ingredient",
        ingredient: { id: resolved.id, name: resolved.name },
        recipe: null,
        amounts: fresh.amounts.map((a) => {
          const amount: Amount = { value: a.value, unit: a.unit };
          if (a.upper_value != null) amount.upperValue = a.upper_value;
          return amount;
        }),
        modifier: fresh.modifier ?? null,
        aliases: resolved.aliases ?? [],
      });
      toast.success(`Updated to "${resolved.name}"`);
    } catch (error) {
      showErrorToast(error, "Re-parse failed");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="mt-1 flex flex-col gap-y-1 pl-6">
      <span
        className="truncate text-xs text-muted-foreground italic"
        title={rawLine}
      >
        from: {rawLine}
      </span>
      {drifted && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {drift.name !== null && (
            <DriftIndicator
              axis="name"
              before={currentName ?? ""}
              after={drift.name}
            />
          )}
          {drift.amounts !== null && (
            <DriftIndicator
              axis="amount"
              before={formatAmounts(persistedAmounts)}
              after={formatAmounts(drift.amounts)}
            />
          )}
          {drift.modifier !== null && (
            <DriftIndicator
              axis="modifier"
              before={modifier ?? ""}
              after={drift.modifier}
              className="max-w-[20rem]"
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 shrink-0 gap-1 px-1 text-xs"
            disabled={applying}
            onClick={apply}
            title="Re-parse this line with the current parser and apply"
          >
            <ArrowClockwiseIcon className="size-3" />
            Re-parse
          </Button>
        </div>
      )}
    </div>
  );
}

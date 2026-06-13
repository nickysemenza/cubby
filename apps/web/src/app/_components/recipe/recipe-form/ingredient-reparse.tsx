import type { Amount } from "@cubby/schemas/codec";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { computeParseDrift, hasDrift } from "~/lib/parse-drift";
import { wasm } from "~/lib/wasm";
import { useTRPC } from "~/trpc/react";
import { formatAmounts } from "../../inventory/format-amount";
import { DriftIndicator } from "../../parse-drift-indicator";
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
  const api = useTRPC();
  const queryClient = useQueryClient();
  const createMutation = useMutation(api.ingredient.create.mutationOptions());
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
  // Project the draft amounts to the persisted {value, unit} shape (drop half-typed
  // rows), matching exactly what the apply/import path stores.
  const persistedAmounts: Amount[] = (amounts ?? []).flatMap((a) =>
    a.value != null && a.unit?.trim() ? [{ value: a.value, unit: a.unit }] : [],
  );
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
      // Find-or-create the freshly-parsed ingredient (mirrors the combobox's
      // WithIngredientSearch flow) so the row points at a real ingredient id.
      const resolved =
        (await queryClient.fetchQuery(
          api.ingredient.getByName.queryOptions({ nameFilter: fresh.name }),
        )) ??
        (await createMutation.mutateAsync({ name: fresh.name, aliases: [] }));

      const current = form.getValues(
        `sections.${sectionIndex}.ingredients.${ingredientIndex}`,
      );
      // Replace the whole row so the nested amounts field array re-mounts.
      onApply({
        ...current,
        type: "ingredient",
        ingredient: { id: resolved.id, name: resolved.name },
        recipe: null,
        amounts: fresh.amounts.map((a) => ({ value: a.value, unit: a.unit })),
        modifier: fresh.modifier ?? null,
        aliases: resolved.aliases ?? [],
      });
      toast.success(`Updated to "${resolved.name}"`);
    } catch {
      toast.error("Re-parse failed");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="mt-1 flex flex-col gap-y-0.5 pl-8">
      <span
        className="truncate text-muted-foreground/70 text-xs italic"
        title={rawLine}
      >
        from: {rawLine}
      </span>
      {drifted && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
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
            <RefreshCw className="h-3 w-3" />
            Re-parse
          </Button>
        </div>
      )}
    </div>
  );
}

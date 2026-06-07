import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { wasm } from "~/lib/wasm";
import { useTRPC } from "~/trpc/react";
import type { IngItem, RecipeFormValues } from "./types";

/**
 * Per-row provenance + "re-parse this line" action in the recipe editor. Shows the
 * original import line (read-only), and when re-parsing it with the *current*
 * parser would yield a different ingredient name than the row holds, offers a
 * button to apply that fresh parse to the form row. The user still saves the form
 * to persist; this only restages the row.
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

  // Only plain ingredient rows that carry an original line can be re-parsed.
  if (type !== "ingredient" || !rawLine) return null;

  const fresh = wasm.parse_ingredient(rawLine);
  const norm = (s: string) => s.trim().toLowerCase();
  // Real drift only if the parsed name isn't one the current ingredient already
  // answers to (its name or any alias) — so an alias hit isn't a false positive.
  const known = new Set([currentName ?? "", ...(aliases ?? [])].map(norm));
  const drifted = !known.has(norm(fresh.name));

  const apply = async () => {
    setApplying(true);
    try {
      // Find-or-create the freshly-parsed ingredient (mirrors the combobox's
      // WithIngredientSearch flow) so the row points at a real ingredient id.
      const resolved =
        (await queryClient.fetchQuery(
          api.ingredient.getByName.queryOptions({ nameFilter: fresh.name }),
        )) ?? (await createMutation.mutateAsync({ name: fresh.name }));

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
    <div className="mt-1 flex items-center gap-2 pl-8">
      <span
        className="truncate text-muted-foreground/70 text-xs italic"
        title={rawLine}
      >
        from: {rawLine}
      </span>
      {drifted && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 shrink-0 gap-1 px-1 text-xs"
          disabled={applying}
          onClick={apply}
          title={`Re-parse this line → "${fresh.name}"`}
        >
          <RefreshCw className="h-3 w-3" />
          Update → {fresh.name}
        </Button>
      )}
    </div>
  );
}

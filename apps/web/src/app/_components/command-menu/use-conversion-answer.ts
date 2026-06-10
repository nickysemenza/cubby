import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
import { wasm } from "~/lib/wasm";
import { useTRPC } from "~/trpc/react";

// "250 g flour in cups" / "1.5 cups sugar to g" / "2 tbsp butter as oz"
const CONVERSION_RE =
  /^(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)\s+(.+?)\s+(?:in|to|as)\s+([a-zA-Z]+)$/i;

export interface ConversionAnswer {
  /** The formatted input amount, e.g. "250 g" */
  input: string;
  ingredientName: string;
  ingredientId: string;
  /** The formatted converted amount, e.g. "2 cups" */
  result: string;
  /** Cost of that amount via the ingredient's price mappings, if priced */
  cost: string | null;
}

/**
 * Inline unit answers for the command menu: parses queries shaped like
 * "250 g flour in cups", resolves the ingredient by name, and converts via
 * its linked products' unit-mapping graph (same WASM path recipe costing
 * uses). Returns null whenever the query isn't a conversion or no unit path
 * exists — the menu just behaves like normal search.
 */
export function useConversionAnswer(search: string): ConversionAnswer | null {
  const trpc = useTRPC();

  const parsed = useMemo(() => {
    const match = CONVERSION_RE.exec(search.trim());
    if (!match) return null;
    const value = Number(match[1]?.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) return null;
    return {
      value,
      unit: match[2] ?? "",
      name: match[3] ?? "",
      target: match[4] ?? "",
    };
  }, [search]);

  const { data: ingredient } = useQuery({
    ...trpc.ingredient.getByName.queryOptions({
      nameFilter: parsed?.name ?? "",
    }),
    enabled: parsed !== null,
    staleTime: 5 * 60 * 1000,
  });

  return useMemo(() => {
    if (!parsed || !ingredient) return null;
    const mappings = getIngredientMappings(ingredient);
    if (mappings.length === 0) return null;

    const amount = { value: parsed.value, unit: parsed.unit };
    try {
      // Both sides canonicalize to grams (standard units natively, custom
      // units like "cup" via the mapping graph); the ratio is the answer.
      const grams = wasm.conv_amount_to_kind(mappings, "weight", amount);
      const gramsPerTarget = wasm.conv_amount_to_kind(mappings, "weight", {
        value: 1,
        unit: parsed.target,
      });
      if (!grams || !gramsPerTarget || gramsPerTarget.value <= 0) return null;
      const converted = {
        value: grams.value / gramsPerTarget.value,
        unit: parsed.target,
      };

      let cost: string | null = null;
      try {
        const money = wasm.conv_amount_to_kind(mappings, "money", amount);
        cost = money ? wasm.format_amount(money) : null;
      } catch {
        cost = null;
      }

      return {
        input: wasm.format_amount(amount),
        ingredientName: ingredient.name,
        ingredientId: ingredient.id,
        result: wasm.format_amount(converted),
        cost,
      };
    } catch {
      // No weight path between these units for this ingredient.
      return null;
    }
  }, [parsed, ingredient]);
}

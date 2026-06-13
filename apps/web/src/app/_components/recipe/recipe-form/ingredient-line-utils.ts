import type { WIngredient } from "@cubby/recipebridge";
import type { Amount } from "@cubby/schemas/codec";
import { uniq } from "es-toolkit";
import type { ReadonlyDeep } from "type-fest";
import { wasm } from "~/lib/wasm";
import type { IngredientMatch } from "../use-ingredient-matches";
import type { IngItem } from "./types";

export interface ParsedIngredientLine {
  raw: string;
  parsed: ReadonlyDeep<WIngredient>;
}

interface ParseIngredientLinesOptions {
  requireName?: boolean;
}

export const parseIngredientLines = (
  lines: readonly string[],
  options: ParseIngredientLinesOptions = {},
): ParsedIngredientLine[] =>
  lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ raw: line, parsed: wasm.parse_ingredient(line) }))
    .filter((item) => !options.requireName || item.parsed.name.length > 0);

export const parsedIngredientNames = (
  parsed: readonly ParsedIngredientLine[],
): string[] =>
  uniq(
    parsed.map((item) => item.parsed.name).filter((name) => name.length > 0),
  );

export const parsedIngredientToFormItem = (
  item: ParsedIngredientLine,
  match: Pick<IngredientMatch, "id" | "name">,
): IngItem => ({
  type: "ingredient",
  ingredient: { id: match.id, name: match.name },
  recipe: null,
  amounts: item.parsed.amounts.map((a) => ({
    value: a.value,
    unit: a.unit,
  })) as Amount[],
  rawLine: item.raw,
  modifier: item.parsed.modifier ?? null,
});

export async function resolveParsedIngredientGroups(
  parsedGroups: readonly (readonly ParsedIngredientLine[])[],
  resolveName: (name: string) => Promise<Pick<IngredientMatch, "id" | "name">>,
): Promise<IngItem[][]> {
  const resolved = new Map<string, Pick<IngredientMatch, "id" | "name">>();

  for (const name of parsedIngredientNames(parsedGroups.flat())) {
    resolved.set(name, await resolveName(name));
  }

  return parsedGroups.map((group) =>
    group.map((item) => {
      const match = resolved.get(item.parsed.name);
      if (!match) {
        throw new Error(`No match found for ingredient: ${item.parsed.name}`);
      }
      return parsedIngredientToFormItem(item, match);
    }),
  );
}

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
): ParsedIngredientLine[] => {
  const filtered = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // One batch WASM call instead of one per line — output order matches input
  // (contract guaranteed by parse_ingredient_lines), so lengths line up and
  // `[i]!` is safe right after the length-matched zip.
  const parsed = wasm.parse_ingredient_lines(filtered);
  return filtered
    .map((line, i) => ({ raw: line, parsed: parsed[i]! }))
    .filter(
      // Trimmed: a whitespace-only name is no more an ingredient than an empty
      // one, and the server drops it (it keys on the trimmed name) — a row kept
      // here would find no match and abort the whole import.
      (item) => !options.requireName || item.parsed.name.trim().length > 0,
    );
};

export const parsedIngredientNames = (
  parsed: readonly ParsedIngredientLine[],
): string[] =>
  uniq(
    parsed
      .map((item) => item.parsed.name)
      .filter((name) => name.trim().length > 0),
  );

// Carry `aliases` onto the row so the Re-parse drift check treats an alias hit
// (e.g. a "granulated sugar" line matched to the "White sugar" ingredient) as a
// match, not drift. Without this the import path leaves aliases empty and every
// alias-matched line falsely shows a Re-parse button.
export const parsedIngredientToFormItem = (
  item: ParsedIngredientLine,
  match: Pick<IngredientMatch, "id" | "name" | "aliases">,
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
  aliases: match.aliases ?? [],
});

export async function resolveParsedIngredientGroups(
  parsedGroups: readonly (readonly ParsedIngredientLine[])[],
  resolveName: (
    name: string,
  ) => Promise<Pick<IngredientMatch, "id" | "name" | "aliases">>,
): Promise<IngItem[][]> {
  const resolved = new Map<
    string,
    Pick<IngredientMatch, "id" | "name" | "aliases">
  >();

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

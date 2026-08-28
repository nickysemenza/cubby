import type { Amount } from "@cubby/schemas/codec";

import { wasm } from "~/lib/wasm";

/**
 * Proposes `1 each = <size>` only when a title is unambiguous. False positives
 * understate unit price, so pack/count ambiguity is deliberately refused. Unit
 * aliases come from WASM and are shared with the SQL prefilter to prevent drift.
 */
export type TitleSizeProposal = {
  amount: Amount;
  token: string;
};

const PACK_MARKER =
  /\b(?:pack\s+of\s+\d+|case\s+of\s+\d+|box\s+of\s+\d+|\d+\s*-?\s*(?:pack|pk)s?\b|\d+\s*(?:ct|count)\b|\d+\s*servings?\b)/i;

/** Match only immediately before a size; title-wide `x` usually means dimensions. */
const MULTIPLIER_PREFIX = /\d+(?:\.\d+)?\s*[x×]\s*$/i;

const COMPATIBILITY_MARKER =
  /\b(?:fits|compatible\s+with|replacement\s+for)\b/i;

/** Recipe measures describe capacity/parts in catalog titles, not package size. */
const RECIPE_MEASURE_STEMS = new Set([
  "c",
  "cup",
  "q",
  "tsp",
  "teaspoon",
  "tbsp",
  "tablespoon",
]);

const stemOf = (alias: string) => alias.replace(/s$/, "");

/** Bare units are case-sensitive so `10G` is not interpreted as ten grams. */
const isBareAlias = (alias: string) => stemOf(alias).length === 1;

const escapeForRegex = (alias: string) =>
  alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** WASM orders aliases longest-first so `fl oz` wins over `oz`. */
const alternationOf = (aliases: readonly string[]) =>
  aliases.map(escapeForRegex).join("|");

const sizeToken = (aliases: readonly string[], flags: string) =>
  new RegExp(
    `(?<![\\d/.])\\b(\\d+(?:\\.\\d+)?)\\s*(${alternationOf(aliases)})\\b(?![/\\d])`,
    flags,
  );

let vocabulary: {
  worded: RegExp;
  bare: RegExp;
  range: RegExp;
  alternation: string;
} | null = null;

const getVocabulary = () => {
  if (vocabulary) return vocabulary;
  const aliases = [...wasm.size_unit_aliases()];
  // The SQL prefilter must remain a superset, so it uses the whole vocabulary.
  const alternation = alternationOf(aliases);
  const matched = aliases.filter(
    (alias) => !RECIPE_MEASURE_STEMS.has(stemOf(alias)),
  );
  vocabulary = {
    worded: sizeToken(
      matched.filter((alias) => !isBareAlias(alias)),
      "gi",
    ),
    bare: sizeToken(matched.filter(isBareAlias), "g"),
    // Only hyphenated matched-unit spans are ranges; em dashes are punctuation.
    range: new RegExp(
      `\\d+\\s*-\\s*\\d+\\s*(?:${alternationOf(matched)})\\b`,
      "i",
    ),
    alternation,
  };
  return vocabulary;
};

/** Regex source for the SQL prefilter; it is a strict superset of JS matching. */
export const sizeUnitAlternation = () => getVocabulary().alternation;

const normalize = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const SIZED_KINDS = new Set(["weight", "volume"]);

/** Returns null for ambiguity or invalid arbitrary catalog text; never throws. */
export const proposeSizeFromTitle = (
  name: string,
): TitleSizeProposal | null => {
  if (PACK_MARKER.test(name) || COMPATIBILITY_MARKER.test(name)) return null;

  const { worded, bare, range } = getVocabulary();
  if (range.test(name)) return null;
  const matches = [...name.matchAll(worded), ...name.matchAll(bare)];
  if (matches.length === 0) return null;

  // Any multiplied occurrence makes attribution to one `each` ambiguous.
  if (
    matches.some(
      (match) =>
        match.index !== undefined &&
        MULTIPLIER_PREFIX.test(name.slice(0, match.index)),
    )
  ) {
    return null;
  }

  // Repeated identical sizes are harmless; distinct sizes are ambiguous.
  const distinct = new Set(matches.map((m) => normalize(m[0])));
  if (distinct.size !== 1) return null;

  const token = matches[0]?.[0];
  if (token === undefined) return null;

  try {
    const amount = wasm.parse_amount(token);
    if (!Number.isFinite(amount.value) || amount.value <= 0) return null;
    if (!SIZED_KINDS.has(wasm.amount_kind(amount))) return null;
    return { amount: { value: amount.value, unit: amount.unit }, token };
  } catch {
    return null;
  }
};

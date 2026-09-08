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
  /\b(?:pack\s+of\s+\d+|case\s+of\s+\d+|box\s+of\s+\d+|set\s+of\s+\d+|\d+\s*-?\s*(?:pack|pk)s?\b|\d+\s*-?\s*(?:ct|count)\b|\d+\s+snack\s+packs?\b|\d+\s*servings?\b)/i;

/** Match only immediately before a size; title-wide `x` usually means dimensions. */
const MULTIPLIER_PREFIX = /\d+(?:\.\d+)?\s*[x×]\s*$/i;

const COMPATIBILITY_MARKER =
  /\b(?:fits|compatible\s+with|replacement\s+for)\b/i;

/** Ratings describe what hardgoods support, not the quantity purchased. */
const LOAD_RATING_MARKER =
  /\b(?:capacity|safe\s+working\s+load|working\s+load|load\s+rating|payload|rated\s+(?:for|to|at)|(?:holds?\s+)?up\s+to\s+\d+(?:\.\d+)?)\b/i;
const HIGH_LOAD_HARDGOOD = /\b(?:ladders?|step\s+stools?|casters?)\b/i;
const BUCKET_COMPATIBILITY_PREFIX = /\b(?:for|fits?)\s*$/i;
const BUCKET_SUFFIX = /^\s*\.?\s+bucket\b/i;
const BUCKET_ACCESSORY_SUFFIX =
  /^\s*\.?\s+(?:(?:metal|plastic|steel)\s+)?bucket\s+(?:grid|lid|liner|insert|tool)\b/i;
const VOLUME_CAPACITY_PRODUCT =
  /\b(?:shop\s?vac|wet\/dry(?:\s+shop)?\s+vacuum|storage\s+tote)\b/i;
const VESSEL_BEFORE_SIZE =
  /\b(?:(?:insulated\s+)?water\s+bottle|insulated(?:\s+travel)?\s+tumbler(?:\s+with\b[^,]*)?)[,:-]?\s*$/i;
const VESSEL_AFTER_SIZE =
  /^\s*\.?\s+(?:(?:insulated\s+)?water\s+bottle|insulated(?:\s+travel)?\s+tumbler)\b/i;

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

const findUnambiguousSizeMatch = (name: string) => {
  const { worded, bare, range } = getVocabulary();
  if (range.test(name)) return null;

  const matches = [...name.matchAll(worded), ...name.matchAll(bare)];
  if (matches.length === 0) return null;

  // Any multiplied occurrence makes attribution to one `each` ambiguous.
  const hasMultiplier = matches.some(
    (match) =>
      match.index !== undefined &&
      MULTIPLIER_PREFIX.test(name.slice(0, match.index)),
  );
  if (hasMultiplier) return null;

  // Repeated identical sizes are harmless; distinct sizes are ambiguous.
  const distinct = new Set(matches.map((match) => normalize(match[0])));
  return distinct.size === 1 ? (matches[0] ?? null) : null;
};

const isHighLoadHardgood = (name: string, amount: Amount, kind: string) =>
  kind === "weight" &&
  amount.unit === "lb" &&
  amount.value >= 100 &&
  HIGH_LOAD_HARDGOOD.test(name);

const hasContextualCapacity = (
  name: string,
  match: RegExpMatchArray,
  kind: string,
) => {
  if (match.index === undefined) return false;

  const before = name.slice(0, match.index);
  const after = name.slice(match.index + match[0].length);
  if (VESSEL_BEFORE_SIZE.test(before) || VESSEL_AFTER_SIZE.test(after)) {
    return true;
  }

  return (
    kind === "volume" &&
    (VOLUME_CAPACITY_PRODUCT.test(name) ||
      BUCKET_ACCESSORY_SUFFIX.test(after) ||
      (BUCKET_COMPATIBILITY_PREFIX.test(before) && BUCKET_SUFFIX.test(after)))
  );
};

const hasNonPackageContext = (
  name: string,
  match: RegExpMatchArray,
  amount: Amount,
  kind: string,
) =>
  LOAD_RATING_MARKER.test(name) ||
  isHighLoadHardgood(name, amount, kind) ||
  hasContextualCapacity(name, match, kind);

/** Returns null for ambiguity or invalid arbitrary catalog text; never throws. */
export const proposeSizeFromTitle = (
  name: string,
): TitleSizeProposal | null => {
  if (PACK_MARKER.test(name) || COMPATIBILITY_MARKER.test(name)) return null;

  const match = findUnambiguousSizeMatch(name);
  if (match === null) return null;
  const token = match[0];
  if (token === undefined) return null;

  try {
    const amount = wasm.parse_amount(token);
    if (!Number.isFinite(amount.value) || amount.value <= 0) return null;
    const kind = wasm.amount_kind(amount);
    if (!SIZED_KINDS.has(kind)) return null;

    if (hasNonPackageContext(name, match, amount, kind)) return null;

    return { amount: { value: amount.value, unit: amount.unit }, token };
  } catch {
    return null;
  }
};

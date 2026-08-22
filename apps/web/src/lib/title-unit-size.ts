import type { Amount } from "@cubby/schemas/codec";
import { wasm } from "~/lib/wasm";

/**
 * Read a product's pack size out of its own NAME, when — and only when — the
 * title says it unambiguously.
 *
 * Most of the catalog states its size in the title and carries no unit mapping,
 * so it can show no comparable unit price at all: "Bagged Yellow Onions, 32 OZ"
 * knows what a bag costs but not what an ounce costs. This turns that title
 * into a PROPOSED `1 each = <size>` edge for a human to accept.
 *
 * ## Why this refuses so much
 *
 * The failure mode is not "no proposal", it is a WRONG proposal — and a wrong
 * one always errs toward making the product look CHEAPER per ounce, which is
 * the direction that silently wins a price comparison. The same
 * size-plus-count grammar means opposite things and the string cannot settle
 * it:
 *
 * - `Sparkling Water, 12-pack, 12 fl oz` → one `each` is 144 fl oz,
 *   not 12. Taking the token at face value is **12x too cheap**.
 * - `Almond Milk, 32 Oz (Pack Of 6)` → 192 oz, not 32.
 * - `Dog Dental Treats (27 oz, 45 ct)` → here 27 oz genuinely IS the total.
 *
 * The treats and the sparkling water are the same shape with inverted meaning,
 * so anything carrying a pack marker is refused outright rather than guessed
 * at. Silence is cheap here (the row just keeps no mapping); a confident wrong
 * number is not.
 *
 * ## Where the unit vocabulary comes from
 *
 * Not from here. Every spelling this module matches is handed over by
 * `wasm.size_unit_aliases()`, which filters candidates through the grammar's
 * own `Unit::from_str` + `kind()`. This file contributes the *shape* of a size
 * token (a number, then a unit, not inside a fraction) and nothing about which
 * units exist — per the layering rule in docs/agents/domain-rules.md, "Cubby
 * domain compute belongs in recipebridge/WASM; TypeScript assembles inputs and
 * reshapes outputs instead of recreating it."
 *
 * A transcribed copy is not a style problem, it drifts: the SQL prefilter that
 * shares this vocabulary once listed singular spellings only, and Postgres's
 * `\M` word-end anchor then rejected every "5 pounds" title — accepted here,
 * never delivered there.
 */
export type TitleSizeProposal = {
  /** The proposed right-hand side of `1 each = <amount>`. */
  amount: Amount;
  /** The exact substring this came from, so the UI can show its own evidence. */
  token: string;
};

/**
 * A count of packages anywhere in the title. Its presence means the size token
 * cannot be attributed to one `each` — see the class doc.
 */
const PACK_MARKER =
  /\b(?:pack\s+of\s+\d+|case\s+of\s+\d+|box\s+of\s+\d+|\d+\s*-?\s*(?:pack|pk)s?\b|\d+\s*(?:ct|count)\b|\d+\s*servings?\b)/i;

/**
 * A bare multiplier sitting IMMEDIATELY before a size: the `3x` of `(3x16 oz)`.
 *
 * {@link PACK_MARKER} anchors on the WORDS pack/pk/ct/count/servings, so this
 * shape slipped past it, and then past the distinct-size guard too — the `3`
 * carries no unit, so only one size token is ever found and the title looks
 * unambiguous. The result was `1 each = 16 oz` for a 48 oz trio: the same
 * cheaper-per-ounce error the pack marker exists to refuse.
 *
 * ⚠️ Tested against the text immediately before the matched token, NOT against
 * the whole title. A title-wide version cost 14 CORRECT proposals on the live
 * catalog, because an `x` elsewhere in a title is usually a dimension, not a
 * count: "#10 x 3-1/2 in. Star Drive … Screws 1 lb. Box" is a one-pound box of
 * screws whose `x` describes the screw, and paper is "8.5 x 11". Anchoring to
 * the token keeps those while still refusing "(3x16 oz)".
 *
 * The one knowing cost is marketing copy: a "2X coverage" spray paint labelled
 * "2X 12 oz" is refused even though 12 oz is the can. Net on the catalog is one
 * proposal, and it errs toward silence, which is the direction this module
 * always takes — see the class doc.
 *
 * Both the ASCII `x` and the real multiplication sign appear in titles.
 */
const MULTIPLIER_PREFIX = /\d+(?:\.\d+)?\s*[x×]\s*$/i;

/**
 * The size belongs to something else the product FITS, not to the product.
 * "Peanut Butter Stirrer (Fits 26-30oz Jars)" would otherwise propose
 * 30 oz for a stirrer. Found by running this over the real catalog, not by
 * imagining cases.
 */
const COMPATIBILITY_MARKER =
  /\b(?:fits|compatible\s+with|replacement\s+for)\b/i;

/**
 * Units the grammar knows that a PRODUCT TITLE does not use to state a package
 * size. Excluded by stem, so the plurals the grammar derives go with them.
 *
 * This is the one place where the vocabulary is narrowed by hand, and each
 * entry is here because a real catalog title made it wrong — not because the
 * unit is doubtful. The grammar is a RECIPE grammar, and its cooking measures
 * mean something else on a package:
 *
 * - `q` read the part number in "Cove Router Bit … 1/4-Inch Shank 13155q" as
 *   **13,155 quarts**. Same shape as the 10G ethernet cable below, and the
 *   reason single letters can never be admitted casually.
 * - `cup` is a CAVITY on "Nonstick Muffin Pan, Set of 2, 12 Cups" and a
 *   THROUGHPUT on "Cooking Oil Solidifier (Solidifies 20 Cups)"; on "16 Cup
 *   Food Processor" and "10 Cup Water Pitcher" it is the vessel's capacity,
 *   which is not a quantity of anything you bought.
 * - `tsp`/`tbsp` produced nothing either way across the whole catalog; they are
 *   excluded with the rest so the rule is "recipe measures don't size retail
 *   packages" rather than a per-unit judgement call.
 *
 * The stems are asserted against the exported vocabulary in the unit tests, so
 * an entry that stops corresponding to a real alias fails rather than sitting
 * here forever as a no-op.
 */
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

/**
 * A single-letter unit, or the plural the grammar derives from one.
 *
 * These and only these match case-SENSITIVELY: `g` read case-insensitively
 * turns the "10G" in "Cat6 Ethernet Cable … 550Mhz, 10G, UTP" into ten grams —
 * a title shape found by running this over the catalog, not by imagining it.
 *
 * The rule is a fact about the alias's own shape rather than a list of letters,
 * so a single-letter unit the grammar learns later lands in the case-sensitive
 * group on its own — there is no second place to remember to update.
 */
const isBareAlias = (alias: string) => stemOf(alias).length === 1;

/** Aliases are `[a-z ]` only, but never interpolate unescaped into a regex. */
const escapeForRegex = (alias: string) =>
  alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `\M` (Postgres) and `\b` (JS) both need the alternation ordered longest-first
 * so "fl oz" wins over "oz"; `size_unit_aliases()` already returns it that way,
 * and `filter` preserves that order.
 */
const alternationOf = (aliases: readonly string[]) =>
  aliases.map(escapeForRegex).join("|");

const sizeToken = (aliases: readonly string[], flags: string) =>
  new RegExp(
    `(?<![\\d/.])\\b(\\d+(?:\\.\\d+)?)\\s*(${alternationOf(aliases)})\\b(?![/\\d])`,
    flags,
  );

/**
 * Built once from the grammar's vocabulary. Lazy rather than top-level so the
 * WASM module is touched on first use, matching how the other detectors reach
 * it, and memoized because the alias list cannot change within a process.
 */
let vocabulary: {
  worded: RegExp;
  bare: RegExp;
  range: RegExp;
  /** Regex source shared with the SQL prefilter — see {@link sizeUnitAlternation}. */
  alternation: string;
} | null = null;

const getVocabulary = () => {
  if (vocabulary) return vocabulary;
  const aliases = [...wasm.size_unit_aliases()];
  // The SQL prefilter takes the WHOLE vocabulary; only the matcher narrows it.
  // That ordering is what keeps the prefilter a superset for free.
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
    // A span, not a size: the gallons in "Shop Vacuum Filter for Most 5-16
    // Gal. Wet Dry Vacs" belong to the vacuum, and "Commercial 6-8 Quart Lid"
    // otherwise proposes 8 quarts for a lid. "Fits 26-30oz Jars" only escaped
    // this class because it happened to say "Fits".
    //
    // Two deliberate narrowings, both because the wider version misfired on
    // real titles: the separator is a plain HYPHEN only (an em-dash is
    // punctuation — "Nursery Perennial PP#12949 — 1 gal" is a one-gallon
    // plant, not a range), and the units are the MATCHED vocabulary, not the
    // full one (with `c` included, the part number in "DPG82-11C" reads as
    // a range).
    range: new RegExp(
      `\\d+\\s*-\\s*\\d+\\s*(?:${alternationOf(matched)})\\b`,
      "i",
    ),
    alternation,
  };
  return vocabulary;
};

/**
 * The unit alternation as regex source, for the Postgres prefilter in
 * `findProductsWithoutUnitMappings`.
 *
 * That predicate must stay a strict SUPERSET of what {@link
 * proposeSizeFromTitle} matches, or a title this module would accept is
 * silently dropped before it ever arrives. It is a superset BY CONSTRUCTION
 * here: both come from the same `size_unit_aliases()` call, and the SQL uses
 * the whole list case-insensitively while the matcher above only ever narrows
 * it (the bare-alias case rule). There is no second list to keep in step.
 */
export const sizeUnitAlternation = () => getVocabulary().alternation;

const normalize = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The kinds a pack size can honestly be.
 *
 * The vocabulary is already filtered to weight and volume upstream, so this no
 * longer has to catch `qt` parsing as `1 whole` — that spelling never reaches
 * here now. It stays as the final word because it is the grammar's OWN verdict
 * on the parsed amount rather than on the spelling, and this is a boundary
 * where being wrong misstates money.
 */
const SIZED_KINDS = new Set(["weight", "volume"]);

/**
 * `null` whenever the title does not unambiguously state one pack size.
 *
 * Never throws: `parse_amount` and `amount_kind` are given arbitrary catalog
 * text, and a detector that could throw would take the whole Problems page with
 * it.
 */
export const proposeSizeFromTitle = (
  name: string,
): TitleSizeProposal | null => {
  if (PACK_MARKER.test(name) || COMPATIBILITY_MARKER.test(name)) return null;

  const { worded, bare, range } = getVocabulary();
  if (range.test(name)) return null;
  // `matchAll` builds a fresh iterator each call, so the module-level /g regexes
  // never carry `lastIndex` between products.
  const matches = [...name.matchAll(worded), ...name.matchAll(bare)];
  if (matches.length === 0) return null;

  // `some`, not a test on the first match: the same size can appear twice with
  // different context, and a multiplier in front of ANY occurrence means we
  // cannot attribute the size to one `each`. Refusing is the safe direction.
  if (
    matches.some(
      (match) =>
        match.index !== undefined &&
        MULTIPLIER_PREFIX.test(name.slice(0, match.index)),
    )
  ) {
    return null;
  }

  // More than one DISTINCT size is the tell that we cannot say which one is
  // per-each ("5 lb and 2 lb assortment", "12-pack, 12 fl oz" once the pack
  // marker is gone). Repeats of the same size are harmless and collapse here.
  //
  // This does NOT catch a bare multiplier — `12 x 1.4 oz` yields exactly one
  // size token, because the 12 carries no unit — which is why
  // {@link MULTIPLIER_MARKER} refuses that shape at the gate instead. An
  // earlier comment here credited this guard with covering "2 x 42 inch"; it
  // only ever did so because that title happens to carry a second real size.
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

import type { Amount } from "@cubby/schemas/codec";
import { wasm } from "~/lib/wasm";

/**
 * Read a product's pack size out of its own NAME, when — and only when — the
 * title says it unambiguously.
 *
 * Most of the catalog states its size in the title and carries no unit mapping,
 * so it can show no comparable unit price: "Bagged Yellow Onions, 32 OZ" at
 * $2.73 could not report $0.085/oz. This turns that title into a PROPOSED
 * `1 each = <size>` edge for a human to accept.
 *
 * ## Why this refuses so much
 *
 * The failure mode is not "no proposal", it is a WRONG proposal — and a wrong
 * one always errs toward making the product look CHEAPER per ounce, which is
 * the direction that silently wins a price comparison. The same
 * size-plus-count grammar means opposite things and the string cannot settle
 * it:
 *
 * - `La Croix Sparkling Water, 12-pack, 12 fl oz` → one `each` is 144 fl oz,
 *   not 12. Taking the token at face value is **12x too cheap**.
 * - `Califia Almond Milk, 32 Oz (Pack Of 6)` → 192 oz, not 32.
 * - `Greenies Dog Treats (27 oz, 45 ct)` → here 27 oz genuinely IS the total.
 *
 * Greenies and La Croix are the same shape with inverted meaning, so anything
 * carrying a pack marker is refused outright rather than guessed at. Silence is
 * cheap here (the row just keeps no mapping); a confident wrong number is not.
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
 * The size belongs to something else the product FITS, not to the product.
 * "EZPB Peanut Butter Stirrer (Fits 26-30oz Jars)" would otherwise propose
 * 30 oz for a stirrer. Found by running this over the real catalog, not by
 * imagining cases.
 */
const COMPATIBILITY_MARKER =
  /\b(?:fits|compatible\s+with|replacement\s+for)\b/i;

/**
 * Candidate size tokens. This regex only LOCATES text — it never interprets it.
 * `wasm.parse_amount` owns the grammar (the `ingredient` crate), and a TS regex
 * that tried to parse the amount itself would drift from it.
 *
 * `fl oz` leads the alternation so it wins over bare `oz` on "12 fl oz".
 */
const SIZE_TOKEN =
  /(?<![\d/.])\b(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|oz|ounces?|lbs?|pounds?|kilograms?|kg|grams?|milliliters?|millilitres?|ml|liters?|litres?|gallons?|gal|quarts?)\b(?![/\d])/gi;

/**
 * Bare single-letter units, which only count when written lowercase with the
 * number attached or spaced — `500 g`, `5g`, `2 l`.
 *
 * Kept out of {@link SIZE_TOKEN} because case-insensitive `g` matches the "10G"
 * in "Monoprice Cat6 … 550Mhz, 10G, UTP", proposing 10 grams for an ethernet
 * cable. Real title, found by running this over the catalog.
 */
const BARE_UNIT_TOKEN = /(?<![\d/.])\b(\d+(?:\.\d+)?)\s*([gl])\b(?![/\d])/g;

/**
 * The kinds a pack size can honestly be. Rejects `12 in. Pry Bar`.
 *
 * ⚠️ This gate is not belt-and-braces, it catches a live failure. The grammar
 * does NOT know the abbreviations `qt` and `pt`: `parse_amount("1 qt")` returns
 * `1 whole` with kind `other:whole`, silently discarding the unit. Without this
 * check a quart of sealer would be proposed as "1 each = 1 whole". Those two
 * abbreviations are therefore left out of {@link SIZE_TOKEN} entirely — a
 * locator match that can never round-trip is only a way to make a second, real
 * size token look ambiguous.
 *
 * `pint` is a related quirk: it parses, but as kind `other:pint` rather than
 * `volume`, so pint-sized titles are skipped too. Deliberately not worked
 * around here — widening this set to chase `other:*` would re-admit
 * `other:whole`, which is the exact bug above. If the grammar learns these
 * units, add them back to `SIZE_TOKEN` and they will flow through.
 */
const SIZED_KINDS = new Set(["weight", "volume"]);

const normalize = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

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

  // `matchAll` builds a fresh iterator each call, so the module-level /g regexes
  // never carry `lastIndex` between products.
  const matches = [
    ...name.matchAll(SIZE_TOKEN),
    ...name.matchAll(BARE_UNIT_TOKEN),
  ];
  if (matches.length === 0) return null;

  // More than one DISTINCT size is the tell that we cannot say which one is
  // per-each ("2 x 42 inch", "12-pack, 12 fl oz" once the pack marker is gone).
  // Repeats of the same size are harmless and collapse here.
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

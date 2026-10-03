import {
  comparableModel,
  manufacturerSource,
  type ExternalIdKind,
} from "@cubby/schemas/external-id";

/** Shown beside a candidate that only shares a family/style number. */
export const MODEL_STYLE_MATCH_REASON =
  "shared model/style number; confirm size and color";

const MANUFACTURER_PART = "manufacturer_part" satisfies ExternalIdKind;

const hasDigit = /\d/u;
const MIN_MODEL_LENGTH = 3;
const MAX_SOURCE_WORDS = 3;

const comparableToken = (value: string) =>
  value.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, "");

const titleWords = (title: string) =>
  title.split(/[^\p{L}\p{N}-]+/u).filter((word) => word.length > 0);

/** Title words that look like a model/style number (alphanumeric with a digit). */
export const modelStyleTokens = (title: string): string[] =>
  titleWords(title).filter(
    (word) =>
      comparableToken(word).length >= MIN_MODEL_LENGTH && hasDigit.test(word),
  );

/**
 * Whether an order line names an existing Product's `model` AND its
 * manufacturer. A family/style number is shared by sibling sizes and colors, so
 * this is candidate-ranking evidence only, never identity: the caller must not
 * report it as an exact identifier match.
 */
export function sharesModelWithinManufacturer(
  title: string,
  candidate: { manufacturer: string; model: string | null },
): boolean {
  const model = comparableModel(candidate.model);
  if (!model) return false;
  const maker = candidate.manufacturer
    ? titleWords(candidate.manufacturer).map(comparableToken).filter(Boolean)
    : [];
  if (maker.length === 0) return false;
  const words = new Set(titleWords(title).map(comparableToken));
  return words.has(model) && maker.every((word) => words.has(word));
}

/**
 * Exact-identity requests for a line SKU read as a manufacturer part number.
 * The order line does not name the manufacturer, so each leading run of title
 * words is tried as the source slug; a hit still needs the stored
 * `(manufacturer slug, manufacturer_part, SKU)` triple to match exactly.
 */
export function manufacturerPartRequests(line: {
  title: string;
  sku?: string | undefined;
}): { source: string; kind: typeof MANUFACTURER_PART; externalId: string }[] {
  const externalId = line.sku;
  if (!externalId) return [];
  const words = titleWords(line.title).slice(0, MAX_SOURCE_WORDS);
  const sources = new Set<string>();
  for (let end = 1; end <= words.length; end += 1) {
    const source = manufacturerSource(words.slice(0, end).join(" "));
    if (source) sources.add(source);
  }
  return [...sources].map((source) => ({
    source,
    kind: MANUFACTURER_PART,
    externalId,
  }));
}

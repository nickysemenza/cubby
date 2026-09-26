import type { ProductVariantComparison } from "@cubby/schemas/product-variant-comparison";

const COLOR_WORDS = [
  ["Navy", /\bnavy\b/],
  ["Black", /\bblack\b/],
  ["White", /\bwhite\b/],
  ["Olive", /\bolive\b/],
  ["Gray", /\b(?:gray|grey)\b/],
  ["Charcoal", /\bcharcoal\b/],
  ["Brown", /\bbrown\b/],
  ["Red", /\bred\b/],
  ["Blue", /\bblue\b/],
  ["Green", /\bgreen\b/],
  ["Orange", /\borange\b/],
  ["Yellow", /\byellow\b/],
  ["Beige", /\bbeige\b/],
  ["Tan", /\btan\b/],
  ["Wheat", /\bwheat\b/],
  ["Pink", /\bpink\b/],
  ["Purple", /\bpurple\b/],
] as const;

const SIZE_WORDS = [
  ["XX-Small", /\b(?:xxsmall|xxs|2xs)\b/],
  ["X-Small", /\b(?:xsmall|xs)\b/],
  ["Small", /\bsmall\b|\bsize\s+s\b/],
  ["Medium", /\bmedium\b|\bsize\s+m\b/],
  ["Large", /\blarge\b|\bsize\s+l\b/],
  ["X-Large", /\b(?:xlarge|xl)\b/],
  ["XX-Large", /\b(?:xxlarge|xxl|2xl)\b/],
] as const;

type VariantFact = { value: string; raw: string };

function explicitWord(
  title: string,
  words: readonly (readonly [string, RegExp])[],
): VariantFact | null {
  const spaced = title
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b(?:extra[- ]small)\b/gi, "xsmall")
    .replace(/\b(?:extra[- ]large)\b/gi, "xlarge")
    .replace(/\bx[- ]small\b/gi, "xsmall")
    .replace(/\bx[- ]large\b/gi, "xlarge")
    .toLowerCase();
  const found = words.flatMap(([value, pattern]) => {
    const match = pattern.exec(spaced);
    return match ? [{ value, raw: match[0] }] : [];
  });
  return found.length === 1 ? found[0]! : null;
}

function explicitSize(title: string): VariantFact | null {
  const alpha = explicitWord(title, SIZE_WORDS);
  const footwear =
    /\b(?:boots?|shoes?|sneakers?|trainers?|sandals?|heels?|loafers?|slippers?|clogs?)\b/i.test(
      title,
    );
  if (!footwear) {
    const garment =
      /\b(?:jeans?|pants?|trousers?|shorts?|skirts?|dresses?|shirts?|jackets?)\b/i.test(
        title,
      );
    if (!garment) return alpha;
    const waist = [...title.matchAll(/\b(?:waist\s*|w)(\d{2})\b/gi)]
      .map((match) => ({ value: `W ${Number(match[1])}`, raw: match[0] }))
      .filter(
        (fact) =>
          Number(fact.value.slice(2)) >= 20 &&
          Number(fact.value.slice(2)) <= 60,
      );
    const numeric = [...title.matchAll(/\b(?:size|sz)\s*(\d{1,2})\b/gi)]
      .map((match) => ({ value: `Size ${Number(match[1])}`, raw: match[0] }))
      .filter(
        (fact) =>
          Number(fact.value.slice(5)) >= 0 && Number(fact.value.slice(5)) <= 60,
      );
    const facts = [...waist, ...numeric];
    return !alpha && new Set(facts.map((fact) => fact.value)).size === 1
      ? facts[0]!
      : alpha && !facts.length
        ? alpha
        : null;
  }
  const sizeCandidates = [
    ...title.matchAll(/\b(?:size|sz|us)\s*(\d{1,2}(?:\.5)?)\b/gi),
    ...title.matchAll(/\b(\d{1,2}(?:\.5)?)\s*us\b/gi),
    ...title.matchAll(/,\s*(\d{1,2}(?:\.5)?)\s*$/gi),
  ]
    .map((match) => ({ size: Number(match[1]), raw: match[0].trim() }))
    .filter(({ size }) => size >= 1 && size <= 18);
  const unique = [...new Set(sizeCandidates.map(({ size }) => size))];
  if (alpha && unique.length) return null;
  return unique.length === 1
    ? { value: `US ${unique[0]}`, raw: sizeCandidates[0]!.raw }
    : alpha;
}

/** Only explicit, unambiguous text becomes a variant fact. */
export function extractVariantFacts(title: string) {
  return { color: explicitWord(title, COLOR_WORDS), size: explicitSize(title) };
}

const compare = (first: string | null, second: string | null) => ({
  first,
  second,
  relation:
    !first || !second
      ? ("unknown" as const)
      : first === second
        ? ("same" as const)
        : ("different" as const),
});

/** Evidence from titles alone. Ambiguous or absent terms stay unknown. */
export function compareProductTitles(
  first: string,
  second: string,
): ProductVariantComparison {
  const firstFacts = extractVariantFacts(first);
  const secondFacts = extractVariantFacts(second);
  return {
    color: compare(
      firstFacts.color?.value ?? null,
      secondFacts.color?.value ?? null,
    ),
    size: compare(
      firstFacts.size?.value ?? null,
      secondFacts.size?.value ?? null,
    ),
  };
}

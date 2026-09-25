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

function explicitWord(
  title: string,
  words: readonly (readonly [string, RegExp])[],
): string | null {
  const spaced = title
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b(?:extra[- ]small)\b/gi, "xsmall")
    .replace(/\b(?:extra[- ]large)\b/gi, "xlarge")
    .replace(/\bx[- ]small\b/gi, "xsmall")
    .replace(/\bx[- ]large\b/gi, "xlarge")
    .toLowerCase();
  const found = words.filter(([, pattern]) => pattern.test(spaced));
  return found.length === 1 ? found[0]![0] : null;
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
  return {
    color: compare(
      explicitWord(first, COLOR_WORDS),
      explicitWord(second, COLOR_WORDS),
    ),
    size: compare(
      explicitWord(first, SIZE_WORDS),
      explicitWord(second, SIZE_WORDS),
    ),
  };
}

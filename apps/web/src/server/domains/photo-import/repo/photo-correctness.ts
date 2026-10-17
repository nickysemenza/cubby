import type { PhotoFieldCrossCheck } from "@cubby/schemas/photo-import-run";
import type { ProductVariantComparison } from "@cubby/schemas/product-variant-comparison";

/** Correctness preserves width letters, size numerals and fractions unlike retrieval. */
export function correctnessTokens(value: string): string[] {
  return [
    ...new Set(
      value.toLowerCase().match(/[\p{L}\p{N}]+(?:[./-][\p{L}\p{N}]+)*/gu) ?? [],
    ),
  ];
}

type Mark = PhotoFieldCrossCheck["mark"];
type PrintedTerm = {
  kind: "number" | "apparel" | "width" | "color" | "identifier";
  key: string;
  printed: string;
};

// Only these structural label terms may propose a correction. Arbitrary OCR words,
// materials, gender, provenance and label boilerplate are never name additions.
const colors = new Set(
  "black white beige blue red green yellow orange purple pink brown gray grey navy tan cream ivory gold silver maroon burgundy olive teal turquoise violet indigo magenta cyan khaki coral lavender charcoal camel peach".split(
    " ",
  ),
);

function comparisonKey(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("½", ".5")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function printedTerms(value: string): PrintedTerm[] {
  const text = value
    .replace(/\b(?:men['’]?s|women['’]?s|male|female|unisex)\b/gi, " ")
    .replace(/made[ \t]+in[ \t]+[\p{L} \t]+/giu, " ")
    .replace(/\b\d+(?:\.\d+)?\s*%/g, " ");
  const terms: PrintedTerm[] = [];
  const numericSpans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(
    /(?<![\p{L}\p{N}.-])(?:(?:US|EU|UK|SIZE)\s*[:.-]?\s*)?(\d{1,3}(?:\.\d+|½)?(?:\s*[x×]\s*\d{1,3})?)(?:\s*([MWD]))?(?![\p{L}\p{N}]|\.\d)/giu,
  )) {
    const width = match[2]?.toUpperCase();
    terms.push({
      kind: "number",
      key: match[1]!
        .replaceAll("½", ".5")
        .replace(/[\s×]/g, (part) => (part === "×" ? "x" : ""))
        .toLowerCase(),
      printed:
        width && width !== "M" ? match[0].slice(0, -1).trim() : match[0].trim(),
    });
    if (width && width !== "M")
      terms.push({
        kind: "width",
        key: width.toLowerCase(),
        printed: match[2]!,
      });
    numericSpans.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  for (const match of text.matchAll(
    /(?<![\p{L}\p{N}])[\p{L}\p{N}]+(?:[./-][\p{L}\p{N}]+)*(?![\p{L}\p{N}])/gu,
  )) {
    if (
      numericSpans.some(
        (span) =>
          match.index < span.end && match.index + match[0].length > span.start,
      )
    )
      continue;
    const printed = match[0];
    const key = printed.toLowerCase();
    if (/^(?:xxs|xs|s|m|l|xl|xxl|xxxl)$/.test(key))
      terms.push({ kind: "apparel", key, printed });
    else if (/^[wd]$/.test(key)) terms.push({ kind: "width", key, printed });
    else if (
      comparisonKey(printed).length >= 5 &&
      /\p{L}/u.test(printed) &&
      /\d/.test(printed)
    )
      terms.push({ kind: "identifier", key: comparisonKey(printed), printed });
    else
      for (const word of printed.match(/[\p{L}]+/gu) ?? []) {
        const color = word.toLowerCase();
        if (colors.has(color))
          terms.push({
            kind: "color",
            key: color === "grey" ? "gray" : color,
            printed: word,
          });
      }
  }
  return terms.filter(
    (term, index) =>
      terms.findIndex(
        (other) => other.kind === term.kind && other.key === term.key,
      ) === index,
  );
}

function sameTerm(first: PrintedTerm, second: PrintedTerm): boolean {
  return first.kind === second.kind && first.key === second.key;
}

function aggregateMark(tokens: PhotoFieldCrossCheck["tokens"]): Mark {
  if (tokens.some((token) => token.mark === "disagree-or-missing"))
    return "disagree-or-missing";
  return tokens.length && tokens.every((token) => token.mark === "agree")
    ? "agree"
    : "unknown";
}

/** Literal OCR can prove agreement; absent catalog prose is unknown. Model
 * relations remain unverified. Size contradictions never propose a name append. */
export function photoFieldCrossCheck(
  product: {
    name: string;
    manufacturer?: string | null;
    model?: string | null;
    identifiers: readonly string[];
  },
  printedEvidence: readonly string[],
  variant?: ProductVariantComparison,
): PhotoFieldCrossCheck[] {
  const observed = correctnessTokens(printedEvidence.join("\n"));
  const tokenKeys = (text: string) =>
    [text, ...text.split(/[./-]/)].map(comparisonKey);
  const observedKeys = new Set(observed.flatMap(tokenKeys));
  const literalAgrees = (text: string) =>
    observedKeys.has(comparisonKey(text)) ||
    text.split(/[./-]/).every((part) => observedKeys.has(comparisonKey(part)));
  const labelTerms = printedTerms(printedEvidence.join("\n"));
  const productTerms = printedTerms(product.name);
  const sizeKinds = new Set<PrintedTerm["kind"]>([
    "number",
    "apparel",
    "width",
  ]);
  const missingTerms = labelTerms.filter(
    (term) =>
      (sizeKinds.has(term.kind) || term.kind === "color") &&
      !productTerms.some((other) => sameTerm(term, other)),
  );
  const conflictingSize = missingTerms.some(
    (term) =>
      sizeKinds.has(term.kind) &&
      productTerms.some((other) => other.kind === term.kind),
  );
  const missingNameTerms = missingTerms.filter(
    (term) => term.kind === "color" || !conflictingSize,
  );
  const nameTokens = correctnessTokens(product.name).map(
    (text): PhotoFieldCrossCheck["tokens"][number] => {
      // A possessive suffix split from a gender word is not a standalone size.
      const terms = printedTerms(text).filter(
        (term) =>
          term.kind !== "identifier" &&
          productTerms.some((other) => sameTerm(term, other)),
      );
      let mark: Mark = literalAgrees(text) ? "agree" : "unknown";
      if (terms.length) {
        if (
          terms.every((term) =>
            labelTerms.some((other) => sameTerm(term, other)),
          )
        )
          mark = "agree";
        else if (
          terms.some(
            (term) =>
              sizeKinds.has(term.kind) &&
              labelTerms.some(
                (other) => other.kind === term.kind && !sameTerm(term, other),
              ),
          )
        )
          mark = "disagree-or-missing";
      }
      return { text, mark };
    },
  );
  for (const term of missingNameTerms) {
    if (!nameTokens.some((token) => token.text === term.key))
      nameTokens.push({ text: term.key, mark: "disagree-or-missing" });
  }
  const result: PhotoFieldCrossCheck[] = [
    {
      field: "name",
      source: "deterministic",
      mark: aggregateMark(nameTokens),
      tokens: nameTokens,
      labelValue:
        [
          // Size and colour words have their own rows; repeating them here
          // makes a lone "9" look like name evidence.
          ...nameTokens
            .filter(
              (token) =>
                token.mark === "agree" &&
                !printedTerms(token.text).some(
                  (term) => sizeKinds.has(term.kind) || term.kind === "color",
                ),
            )
            .map((token) => token.text),
          ...missingNameTerms.map((term) => term.printed),
        ].join(" ") || null,
      productValue: product.name,
      suggestion: missingNameTerms[0]
        ? { kind: "add_to_name", value: missingNameTerms[0].printed }
        : null,
    },
  ];
  for (const field of ["manufacturer", "model"] as const) {
    const value = product[field] ?? null;
    const tokens = correctnessTokens(value ?? "").map((text) => ({
      text,
      mark: literalAgrees(text) ? ("agree" as const) : ("unknown" as const),
    }));
    result.push({
      field,
      source: "deterministic",
      mark: aggregateMark(tokens),
      tokens,
      labelValue:
        observed
          .filter((text) =>
            tokens.some(
              (token) =>
                token.mark === "agree" &&
                tokenKeys(text).some((key) =>
                  tokenKeys(token.text).includes(key),
                ),
            ),
          )
          .join(" ") || null,
      productValue: value,
      suggestion: null,
    });
  }
  const knownCodes = new Set(
    [product.model ?? "", ...product.identifiers].map(comparisonKey),
  );
  const missingCodes = labelTerms.filter(
    (term) => term.kind === "identifier" && !knownCodes.has(term.key),
  );
  const identifierTokens: PhotoFieldCrossCheck["tokens"] =
    product.identifiers.map((text) => ({
      text,
      mark: observedKeys.has(comparisonKey(text)) ? "agree" : "unknown",
    }));
  for (const term of missingCodes)
    identifierTokens.push({ text: term.printed, mark: "disagree-or-missing" });
  result.push({
    field: "identifiers",
    source: "deterministic",
    mark: aggregateMark(identifierTokens),
    tokens: identifierTokens,
    labelValue:
      labelTerms
        .filter(
          (term) =>
            term.kind === "identifier" &&
            (missingCodes.includes(term) ||
              product.identifiers.some(
                (identifier) => comparisonKey(identifier) === term.key,
              )),
        )
        .map((term) => term.printed)
        .join(" / ") || null,
    productValue: product.identifiers.join(" / ") || null,
    // OCR establishes the code, not its issuer or whether it is a model,
    // style, or exact-variant identifier. Keep it as evidence until classified.
    suggestion: null,
  });
  for (const field of ["color", "size"] as const) {
    const applies = (term: PrintedTerm) =>
      field === "color" ? term.kind === "color" : sizeKinds.has(term.kind);
    const label = labelTerms.filter(applies);
    const catalog = productTerms.filter(applies);
    const missing = label.filter(
      (term) => !catalog.some((other) => sameTerm(term, other)),
    );
    result.push({
      field,
      source: label.length ? "deterministic" : "model",
      mark: label.length
        ? missing.length
          ? "disagree-or-missing"
          : "agree"
        : variant?.[field].relation === "different"
          ? "disagree-or-missing"
          : "unknown",
      tokens: label.map((term) => ({
        text: term.printed,
        mark: catalog.some((other) => sameTerm(term, other))
          ? "agree"
          : "disagree-or-missing",
      })),
      labelValue: label.map((term) => term.printed).join(" / ") || null,
      productValue:
        catalog
          .map((term) => (sizeKinds.has(term.kind) ? term.key : term.printed))
          .join(" / ") || null,
      suggestion:
        missing[0] && !(field === "size" && conflictingSize)
          ? { kind: "add_to_name", value: missing[0].printed }
          : null,
    });
  }
  return result;
}

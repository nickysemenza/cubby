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

/** Only literal OCR/label tokens can establish agreement. Model claims are excluded. */
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
  const observed = new Set(correctnessTokens(printedEvidence.join("\n")));
  const namedElsewhere = new Set(
    correctnessTokens(
      [product.manufacturer, product.model, ...product.identifiers]
        .filter(Boolean)
        .join(" "),
    ),
  );
  const fields = ["name", "manufacturer", "model", "identifiers"] as const;
  const deterministic = fields.map((field): PhotoFieldCrossCheck => {
    const value =
      field === "identifiers" ? product.identifiers.join(" ") : product[field];
    const wanted = correctnessTokens(value ?? "");
    const tokens: PhotoFieldCrossCheck["tokens"] = wanted.map((text) => ({
      text,
      mark: !observed.size
        ? ("unknown" as const)
        : observed.has(text)
          ? ("agree" as const)
          : ("disagree-or-missing" as const),
    }));
    if (field === "name") {
      const catalog = new Set(wanted);
      for (const text of observed)
        if (!catalog.has(text) && !namedElsewhere.has(text))
          tokens.push({ text, mark: "disagree-or-missing" });
    }
    return {
      field,
      source: "deterministic",
      mark:
        !tokens.length || !observed.size
          ? "unknown"
          : tokens.every((token) => token.mark === "agree")
            ? "agree"
            : "disagree-or-missing",
      tokens,
    };
  });
  return [
    ...deterministic,
    ...(["color", "size"] as const).map((field): PhotoFieldCrossCheck => ({
      field,
      source: "model",
      mark:
        variant?.[field].relation === "different"
          ? "disagree-or-missing"
          : "unknown",
      tokens: [],
    })),
  ];
}

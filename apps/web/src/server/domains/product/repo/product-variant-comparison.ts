import type { ProductVariantComparison } from "@cubby/schemas/product-variant-comparison";

/** An abstention still carries the source titles that were presented. */
export const unknownProductVariantComparison = (
  firstTitle: string,
  secondTitle: string,
): ProductVariantComparison => ({
  color: { relation: "unknown" },
  size: { relation: "unknown" },
  evidence: { firstTitle, secondTitle },
});

import type { ProductVariantComparison } from "@cubby/schemas/product-variant-comparison";

import { FactList } from "~/ui/common/fact-list";

/** Closed-choice relations plus the original source text, for human review. */
export function ProductVariantEvidence({
  comparison,
  firstLabel,
  secondLabel,
}: {
  comparison: ProductVariantComparison;
  firstLabel: string;
  secondLabel: string;
}) {
  return (
    <div className="min-w-0 text-xs">
      <FactList
        facts={(["color", "size"] as const).map((field) => {
          const relation = comparison[field].relation;
          return {
            label: field === "color" ? "Color" : "Size",
            tone: relation === "different" ? "warning" : undefined,
            value:
              relation === "same"
                ? "Titles agree"
                : relation === "different"
                  ? "Titles conflict — check evidence"
                  : "Unknown",
          };
        })}
      />
      <details className="mt-1">
        <summary className="cursor-pointer text-muted-foreground">
          Original comparison text
        </summary>
        <p className="mt-1 break-words">
          {firstLabel}: {comparison.evidence.firstTitle}
        </p>
        <p className="break-words">
          {secondLabel}: {comparison.evidence.secondTitle}
        </p>
      </details>
    </div>
  );
}

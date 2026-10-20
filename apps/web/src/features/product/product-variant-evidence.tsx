import type { ProductVariantComparison } from "@cubby/schemas/product-variant-comparison";

import { Facts } from "~/ui/common/facts";
import { Disclosure } from "~/ui/layout/disclosure";

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
      <Facts
        layout="inline"
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
      <Disclosure summary="Original comparison text" className="mt-1">
        <p className="break-words">
          {firstLabel}: {comparison.evidence.firstTitle}
        </p>
        <p className="break-words">
          {secondLabel}: {comparison.evidence.secondTitle}
        </p>
      </Disclosure>
    </div>
  );
}

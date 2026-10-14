import type { ProductVariantComparison } from "@cubby/schemas/product-variant-comparison";

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
    <dl className="grid min-w-0 gap-y-1 text-xs">
      {(["color", "size"] as const).map((field) => {
        const relation = comparison[field].relation;
        return (
          <div key={field} className="flex min-w-0 flex-wrap gap-x-1.5">
            <dt className="font-medium capitalize">{field}</dt>
            <dd
              className={
                relation === "different"
                  ? "text-warning"
                  : "text-muted-foreground"
              }
            >
              {relation === "same"
                ? `Titles agree: “${comparison.evidence.firstTitle}” / “${comparison.evidence.secondTitle}”`
                : relation === "different"
                  ? `Titles conflict: “${comparison.evidence.firstTitle}” / “${comparison.evidence.secondTitle}” — check evidence`
                  : `${firstLabel} / ${secondLabel}: relation unknown`}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

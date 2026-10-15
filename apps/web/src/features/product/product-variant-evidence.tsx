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
    <div className="min-w-0 text-xs">
      <dl className="flex flex-wrap gap-x-3 gap-y-1">
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
                  ? "Titles agree"
                  : relation === "different"
                    ? "Titles conflict — check evidence"
                    : "Unknown"}
              </dd>
            </div>
          );
        })}
      </dl>
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

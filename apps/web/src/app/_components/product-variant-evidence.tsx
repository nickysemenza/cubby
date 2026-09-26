import type { ProductVariantComparison } from "@cubby/schemas/product-variant-comparison";

/** Explicit text evidence; the reviewer decides identity from the photos and records. */
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
        const fact = comparison[field];
        return (
          <div key={field} className="flex min-w-0 flex-wrap gap-x-1.5">
            <dt className="font-medium capitalize">{field}</dt>
            <dd
              className={
                fact.relation === "different"
                  ? "text-warning"
                  : "text-muted-foreground"
              }
            >
              {fact.relation === "same"
                ? `${fact.first} in both sources`
                : fact.relation === "different"
                  ? `${firstLabel}: ${fact.first}; ${secondLabel}: ${fact.second} — check evidence`
                  : `${firstLabel}: ${fact.first ?? "unknown"}; ${secondLabel}: ${fact.second ?? "unknown"}`}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

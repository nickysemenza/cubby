import type { ExternalIdOut } from "@cubby/schemas/external-id";

import { ProductGtin, productGtinLabel } from "./product-gtin";

export function ProductExternalIds({
  identifiers,
}: {
  identifiers: readonly Pick<
    ExternalIdOut,
    "source" | "kind" | "externalId" | "url"
  >[];
}) {
  return (
    <span className="inline-flex flex-wrap gap-x-2 gap-y-1 text-xs">
      {identifiers.map((identifier) => {
        const kind =
          identifier.kind === "asin"
            ? "Amazon ASIN"
            : identifier.kind === "gtin_14"
              ? productGtinLabel(identifier.externalId)
              : identifier.kind.replaceAll("_", " ");
        const label = `${identifier.source} · ${kind}: ${identifier.externalId}`;
        if (identifier.kind === "gtin_14")
          return (
            <span
              key={label}
              className="inline-flex min-w-0 items-baseline gap-1"
            >
              {kind}: <ProductGtin gtin={identifier.externalId} />
            </span>
          );
        return identifier.url ? (
          <a
            key={label}
            href={identifier.url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-primary underline-offset-2 hover:underline"
          >
            {label}
          </a>
        ) : (
          <span key={label} className="break-all">
            {label}
          </span>
        );
      })}
    </span>
  );
}

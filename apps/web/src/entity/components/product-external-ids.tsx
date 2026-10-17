import type { ExternalIdOut } from "@cubby/schemas/external-id";

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
            ? "ASIN"
            : identifier.kind === "gtin_14"
              ? "GTIN"
              : identifier.kind.replaceAll("_", " ");
        const label = `${identifier.source} · ${kind}: ${identifier.externalId}`;
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

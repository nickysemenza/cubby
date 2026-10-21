import {
  groupIdentifiers,
  presentIdentifier,
  type PresentedIdentifier,
} from "@cubby/schemas/external-id";

import { wasm } from "~/lib/wasm";

export function ProductExternalIds({
  identifiers,
}: {
  identifiers: readonly PresentedIdentifier[];
}) {
  return (
    <span className="inline-flex flex-col gap-1 text-xs">
      {groupIdentifiers(identifiers).map((group) => (
        <span
          key={JSON.stringify([group[0]?.source, group[0]?.kind])}
          className="inline-flex flex-col gap-1"
        >
          {group.map((identifier) => {
            const shown = presentIdentifier(
              identifier,
              (gtin) => wasm.isbn_from_gtin(gtin)?.isbn13 ?? null,
            );
            const content = (
              <span className="break-all">
                {identifier.source} · {shown.label}:{" "}
                <span className="font-mono tabular-nums">{shown.value}</span>
                {shown.canonical && (
                  <span>
                    {" "}
                    (GTIN:{" "}
                    <span className="font-mono tabular-nums">
                      {shown.canonical}
                    </span>
                    )
                  </span>
                )}
                {shown.role && (
                  <span className="text-muted-foreground"> · {shown.role}</span>
                )}
              </span>
            );
            return shown.url ? (
              <a
                key={JSON.stringify([
                  identifier.source,
                  identifier.kind,
                  identifier.externalId,
                ])}
                href={shown.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline-offset-2 hover:underline"
              >
                {content}
              </a>
            ) : (
              <span
                key={JSON.stringify([
                  identifier.source,
                  identifier.kind,
                  identifier.externalId,
                ])}
              >
                {content}
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}

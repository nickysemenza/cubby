import type {
  ConnectedPathNode,
  ConnectedRecordsOutput,
} from "@cubby/schemas/connected-records";
import type { EntityRef } from "@cubby/schemas/entity";
import { useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { isBrowserRoutedEntity } from "~/entity/entities";
import { cn } from "~/lib/utils";

type ConnectedItem = ConnectedRecordsOutput["items"][number];

/**
 * Unique witnessed records for one batched cover request across a page of paths.
 */
export function connectionRefs(items: readonly ConnectedItem[]): EntityRef[] {
  const refs = items.flatMap((item) => item.paths.flat());
  return [
    ...new Map(
      refs.map((ref) => [`${ref.entityKind}:${ref.entityId}`, ref]),
    ).values(),
  ];
}

/** A shared record identity; equal labels retain distinct shortcodes when needed. */
export function ConnectionRecordLink({
  node,
  disambiguate = false,
}: {
  node: ConnectedPathNode;
  disambiguate?: boolean;
}) {
  if (!isBrowserRoutedEntity(node.entityKind))
    return (
      <span className="min-w-0 truncate" title={node.label}>
        {disambiguate ? `${node.label} · ${node.entityId}` : node.label}
      </span>
    );
  return (
    <EntityRefLink
      entity={node.entityKind}
      id={node.entityId}
      name={disambiguate ? `${node.label} · ${node.entityId}` : node.label}
      // The batched provider supplies covers; a per-chip emoji lookup would
      // spend one request per path node.
      emoji={null}
    />
  );
}

/** Every path expands to its actual records and the declared steps between them. */
export function ConnectionPaths({
  paths,
  compact = false,
  presentation = "disclosure",
}: {
  paths: ConnectedItem["paths"];
  compact?: boolean;
  presentation?: "disclosure" | "expanded";
}) {
  const [expanded, setExpanded] = useState(false);
  const first = paths[0];
  if (!first) return null;
  const labels = [
    ...new Set(first.flatMap((node) => (node.via ? [node.via.label] : []))),
  ];
  const summary = labels.length ? labels.join(" → ") : "Direct connection";
  return (
    <div className={cn("max-w-full min-w-0", compact ? "text-xs" : "text-sm")}>
      {presentation === "disclosure" ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="max-w-full cursor-pointer truncate text-left text-muted-foreground hover:text-foreground"
          title={`Via ${summary}`}
          onClick={() => setExpanded(!expanded)}
        >
          Via {summary}
          {paths.length > 1 ? ` · ${paths.length} paths` : ""}
        </button>
      ) : null}
      {presentation === "expanded" || expanded ? (
        <ul className="mt-1 space-y-2">
          {paths.map((path) => (
            <li key={JSON.stringify(path)}>
              <ol className="flex flex-wrap items-center gap-1">
                {path.map((node, index) => (
                  <li
                    key={JSON.stringify(path.slice(0, index + 1))}
                    className="flex max-w-full min-w-0 flex-wrap items-center gap-1"
                  >
                    {index > 0 ? (
                      <span className="text-muted-foreground">
                        {node.via ? `→ ${node.via.label} →` : "→"}
                      </span>
                    ) : null}
                    <ConnectionRecordLink node={node} />
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A collision is about identity, never merely repeated rows for the same record. */
export function ambiguousConnectionLabels(
  nodes: readonly ConnectedPathNode[],
): ReadonlySet<string> {
  const identities = new Map<string, Set<string>>();
  for (const node of nodes) {
    const refs = identities.get(node.label) ?? new Set<string>();
    refs.add(`${node.entityKind}:${node.entityId}`);
    identities.set(node.label, refs);
  }
  return new Set(
    [...identities].flatMap(([label, refs]) => (refs.size > 1 ? [label] : [])),
  );
}

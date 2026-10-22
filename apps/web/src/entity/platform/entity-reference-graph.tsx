import type { Entity } from "@cubby/schemas/entity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { useMemo } from "react";

import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import { NetworkChart } from "~/ui/charts/network-chart";

/** Schema reference coloring or live referential-health findings. */
export type EntityGraphLens = "logical" | "health";

/** Keep the default stable so unchanged props reuse the settled network layout. */
const EMPTY_UNHEALTHY: ReadonlySet<Entity> = new Set();

interface EntityReferenceGraphProps {
  /** Entity shown in a detail panel elsewhere on the page; drawn with a selection ring. */
  selected?: Entity | null;
  /** Called when a node is clicked. Omit to keep the graph purely decorative (EntityManifestGrid). */
  onSelect?: (entity: Entity) => void;
  /** Node treatment. Defaults to the original reference-graph coloring. */
  lens?: EntityGraphLens;
  /** Entities with at least one live referential-integrity finding — read by the "health" lens. */
  unhealthyEntities?: ReadonlySet<Entity>;
}

export function EntityReferenceGraph({
  selected = null,
  onSelect,
  lens = "logical",
  unhealthyEntities = EMPTY_UNHEALTHY,
}: EntityReferenceGraphProps = {}) {
  const data = useMemo(() => {
    const links = allEntities.flatMap((from) =>
      entityManifest[from].relationships
        .filter(({ target }) => target !== from)
        .map((relation) => ({ source: from, target: relation.target })),
    );
    return {
      nodes: allEntities.map((id) => ({
        id,
        label: id,
        size:
          24 +
          Math.min(links.filter((link) => link.target === id).length, 5) * 6,
        color:
          lens === "health"
            ? unhealthyEntities.has(id)
              ? "var(--destructive)"
              : "var(--slate)"
            : isBrowserRoutedEntity(id)
              ? entities[id].color.accent
              : "var(--slate)",
        selected: selected === id,
        onSelect: onSelect ? () => onSelect(id) : undefined,
      })),
      links,
    };
  }, [selected, onSelect, lens, unhealthyEntities]);
  const shown = selected ? [selected] : allEntities;
  return (
    <div>
      <NetworkChart
        data={data}
        height={420}
        summary={
          lens === "health"
            ? "Entity references. Red nodes have live referential-integrity findings."
            : "Entity references. Node size shows incoming references. Read reference direction and self-references in the list below."
        }
      />
      <details className="border-t border-border p-2 text-xs">
        <summary className="cursor-pointer">
          {selected
            ? `${selected} references`
            : "Reference directions and self-references"}
        </summary>
        <ul className="max-h-64 space-y-2 overflow-auto py-2">
          {shown.map((from) => (
            <li key={from}>
              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(from)}
                  className="min-h-11 text-primary hover:underline sm:min-h-0"
                >
                  {from}
                </button>
              ) : (
                <span className="font-medium">{from}</span>
              )}
              <ul className="pl-3">
                {entityManifest[from].relationships.map((relation) => (
                  <li key={relation.key}>
                    {relation.key} → {relation.target} ({relation.cardinality})
                    {relation.target === from ? " · self-reference" : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

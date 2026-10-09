/**
 * The documentation ERD is a direct projection of the generated logical graph.
 * It deliberately uses a row layout: every declared relation remains legible,
 * including parallel provenance paths and self-relations, without maintaining a
 * second set of nodes, edges, or coordinates.
 */

import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";

const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 38;

const LOGICAL_EDGES = allEntities.flatMap((source) =>
  entityManifest[source].relationships.map((relation) => ({
    source,
    relation,
  })),
);

const provenanceLabel = (
  relation: (typeof LOGICAL_EDGES)[number]["relation"],
) =>
  [relation.sourceKey, ...relation.sources.map((source) => source.key)].join(
    " + ",
  );

export function EntityRelationshipsDiagram() {
  const height = HEADER_HEIGHT + LOGICAL_EDGES.length * ROW_HEIGHT;
  return (
    <svg
      viewBox={`0 0 960 ${height}`}
      width="100%"
      aria-label="Generated logical entity relationship graph"
      style={{ maxWidth: "100%", height: "auto" }}
    >
      <title>Generated Cubby entity relationships</title>
      <text x={16} y={24} fontSize={11} fill="var(--muted-foreground)">
        SOURCE
      </text>
      <text x={220} y={24} fontSize={11} fill="var(--muted-foreground)">
        RELATION · CARDINALITY · PROVENANCE
      </text>
      <text x={790} y={24} fontSize={11} fill="var(--muted-foreground)">
        TARGET
      </text>

      {LOGICAL_EDGES.map(({ source, relation }, index) => {
        const y = HEADER_HEIGHT + index * ROW_HEIGHT;
        return (
          <g key={`${source}.${relation.key}`}>
            <rect
              x={0}
              y={y}
              width={960}
              height={ROW_HEIGHT}
              fill={index % 2 === 0 ? "var(--muted)" : "transparent"}
              fillOpacity={0.28}
            />
            <text x={16} y={y + 21} fontSize={12} fill="var(--foreground)">
              {entitySummary[source].singular}
            </text>
            <text x={220} y={y + 21} fontSize={12} fill="var(--foreground)">
              {relation.label} · {relation.cardinality} ·{" "}
              {provenanceLabel(relation)}
            </text>
            <path
              d={`M 720 ${y + 17} H 774`}
              stroke="var(--muted-foreground)"
              strokeWidth={1.25}
            />
            <path
              d={`M 774 ${y + 17} l -7 -4 m 7 4 l -7 4`}
              fill="none"
              stroke="var(--muted-foreground)"
              strokeWidth={1.25}
            />
            <text x={790} y={y + 21} fontSize={12} fill="var(--foreground)">
              {entitySummary[relation.target].singular}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

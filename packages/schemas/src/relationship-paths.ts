import type { Entity } from "./entity";
import { relationshipQueryDefinition } from "./relationship-query-definitions";
import type {
  EntityRelationship,
  RelationshipProvenance,
} from "./entity-integrity";

export type RelationshipCatalog = readonly {
  key: Entity;
  plural: string;
  relationships: readonly EntityRelationship[];
}[];

export type RelationshipSource = {
  key: string;
  label: string;
  provenance: RelationshipProvenance;
};

export type TraversableRelationship = {
  key: string;
  label: string;
  target: Entity;
  sources: readonly RelationshipSource[];
};

export const relationshipSources = (
  relationship: EntityRelationship,
): readonly RelationshipSource[] => [
  {
    key: relationship.sourceKey ?? "direct",
    label: relationship.label,
    provenance: traversableProvenance(relationship.provenance),
  },
  ...relationship.sources.map((source) => ({
    ...source,
    provenance: traversableProvenance(source.provenance),
  })),
];

const traversableProvenance = (
  provenance: RelationshipProvenance,
): RelationshipProvenance => {
  if (provenance.kind !== "query") return provenance;
  relationshipQueryDefinition(provenance.query);
  return {
    kind: "local-path",
    steps: [
      {
        edge: `Relationship.${provenance.query}`,
        direction: provenance.reverse ? "incoming" : "outgoing",
      },
    ],
  };
};

const samePath = (
  left: readonly { edge: string; direction: string }[],
  right: readonly { edge: string; direction: string }[],
) =>
  left.length === right.length &&
  left.every(
    (step, index) =>
      step.edge === right[index]?.edge &&
      step.direction === right[index]?.direction,
  );

/** One directional catalog for table routes and graph expansion, including inverse self-links. */
export function relationshipsFor(
  catalog: RelationshipCatalog,
  source: Entity,
): readonly TraversableRelationship[] {
  const declared =
    catalog.find((entry) => entry.key === source)?.relationships ?? [];
  return [
    ...declared.map((relationship) => ({
      key: relationship.key,
      label: relationship.label,
      target: relationship.target,
      sources: relationshipSources(relationship),
    })),
    ...catalog.flatMap((candidate) =>
      candidate.relationships.flatMap((relationship) => {
        if (relationship.target !== source) return [];
        const sources = [
          {
            key: relationship.sourceKey ?? "direct",
            label: relationship.label,
            inverse: relationship.inverse,
          },
          ...relationship.sources,
        ].flatMap((named): RelationshipSource[] => {
          const inverse = named.inverse;
          return inverse &&
            !declared.some(
              (local) =>
                local.target === candidate.key &&
                relationshipSources(local).some(
                  (item) =>
                    item.provenance.kind === "local-path" &&
                    samePath(item.provenance.steps, inverse.steps),
                ),
            )
            ? [
                {
                  key: `inverse:${named.key}`,
                  label: named.label,
                  provenance: { kind: "local-path", steps: inverse.steps },
                },
              ]
            : [];
        });
        return sources.length
          ? [
              {
                key: `inverse:${candidate.key}.${relationship.key}`,
                label: candidate.plural,
                target: candidate.key,
                sources,
              },
            ]
          : [];
      }),
    ),
  ];
}

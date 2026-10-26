import type { Entity } from "./entity";
import {
  allEntities,
  entityManifest,
  entityInspectorMetadata,
} from "./entity-manifest";
import type {
  RelationshipPathStep,
  RelationshipWitness,
} from "./entity-integrity";
import {
  createConnectionCatalog,
  relationshipSources,
  type RelationshipCatalog,
} from "./connected-view-definitions";

export { relationshipSources };
const relationshipCatalog: RelationshipCatalog = allEntities.map((key) => ({
  key,
  plural: entityInspectorMetadata[key].plural ?? key,
  relationships: entityManifest[key].relationships,
}));
export const connectionCatalog = createConnectionCatalog(relationshipCatalog);
export type { ConnectedView } from "./connected-view-definitions";

export interface ConnectedPathVariant {
  steps: readonly RelationshipPathStep[];
  target: Entity;
  witnesses: readonly { stepCount: number; witness: RelationshipWitness }[];
}

/** Expand named multi-source relations into the physical paths the server can query. */
export function connectedPathVariants(
  source: Entity,
  route: readonly string[],
): ConnectedPathVariant[] {
  let current = source;
  let variants: readonly ConnectedPathVariant[] = [
    { steps: [], target: source, witnesses: [] },
  ];
  for (const key of route) {
    const relationship = connectionCatalog
      .relationships(current)
      .find((item) => item.key === key);
    if (!relationship)
      throw new Error(`Unknown relationship ${current}.${key}`);
    const primary = relationship.sources[0];
    if (!primary) throw new Error(`No source for ${current}.${key}`);
    const sources = relationship.sources.flatMap((item) =>
      item.provenance.kind === "local-path"
        ? [{ ...item, provenance: item.provenance }]
        : [],
    );
    variants = variants.flatMap((prefix) =>
      sources.map((item) => ({
        steps: [...prefix.steps, ...item.provenance.steps],
        target: relationship.target,
        witnesses: [
          ...prefix.witnesses,
          {
            stepCount: prefix.steps.length + item.provenance.steps.length,
            witness: {
              relationshipKey: key,
              label: item.label,
              sourceKey: item.key,
              provenance: item.provenance.steps.map(
                (step) => `${step.direction}:${step.edge}`,
              ),
            },
          },
        ],
      })),
    );
    current = relationship.target;
  }
  return [...variants];
}

/** Validate the catalog in generation and tests, before any page can request it. */
export function validateConnectedViews(): void {
  for (const source of allEntities) {
    const seen = new Set<string>();
    for (const view of [
      ...connectionCatalog.views(source),
      ...connectionCatalog.views(source, "context"),
    ]) {
      if (seen.has(view.key))
        throw new Error(`Duplicate connected view ${source}.${view.key}`);
      seen.add(view.key);
      for (const route of view.routes) {
        if (
          route.length <
          (("evidence" in view && view.evidence) ||
          view.key.startsWith("entity:")
            ? 1
            : 2)
        )
          throw new Error(
            `Indirect view ${source}.${view.key} needs at least two relationships`,
          );
        const variants = connectedPathVariants(source, route);
        if (
          variants.length === 0 ||
          variants.some((variant) => variant.target !== view.target)
        ) {
          throw new Error(
            `Connected view ${source}.${view.key} does not reach ${view.target}`,
          );
        }
      }
      if (entityManifest[view.target].dbTable === null) {
        throw new Error(
          `Connected view ${source}.${view.key} has no local target`,
        );
      }
    }
  }
}

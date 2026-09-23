import type { Entity } from "./entity";
import {
  allEntities,
  entityManifest,
  localRelationshipByKey,
} from "./entity-manifest";
import type { RelationshipPathStep } from "./entity-integrity";
import { connectedViews } from "./connected-view-definitions";

export { connectedViews } from "./connected-view-definitions";
export type {
  ConnectedView,
  ConnectedViewKey,
} from "./connected-view-definitions";

export interface ConnectedPathVariant {
  steps: readonly RelationshipPathStep[];
  target: Entity;
}

/** Expand named multi-source relations into the physical paths the server can query. */
export function connectedPathVariants(
  source: Entity,
  route: readonly string[],
): ConnectedPathVariant[] {
  let current = source;
  let variants: readonly (readonly RelationshipPathStep[])[] = [[]];
  for (const key of route) {
    const relationship = localRelationshipByKey(current, key);
    const sources = [
      relationship.provenance,
      ...relationship.sources.map((item) => item.provenance),
    ].filter(
      (item): item is Extract<typeof item, { kind: "local-path" }> =>
        item.kind === "local-path",
    );
    variants = variants.flatMap((prefix) =>
      sources.map((item) => [...prefix, ...item.steps]),
    );
    current = relationship.target;
  }
  return variants.map((steps) => ({ steps, target: current }));
}

/** Validate the catalog in generation and tests, before any page can request it. */
export function validateConnectedViews(): void {
  for (const source of allEntities) {
    const seen = new Set<string>();
    for (const view of connectedViews[source]) {
      if (seen.has(view.key))
        throw new Error(`Duplicate connected view ${source}.${view.key}`);
      seen.add(view.key);
      for (const route of view.routes) {
        if (route.length < 2)
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

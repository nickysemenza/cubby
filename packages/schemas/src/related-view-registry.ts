import type { Entity } from "./entity";
import { connectedPathVariants } from "./connected-views";
import type { RelatedViewDefinition } from "./related-view";
import { relatedViewRegistry } from "./generated/related-views.gen";
export { relatedViewRegistry } from "./generated/related-views.gen";

/** Every declared evidence source participates in previews and filters. */
export const relatedViewPaths = (
  view: Pick<RelatedViewDefinition, "source" | "key">,
) => {
  const definition = relatedViewRegistry.find(
    (candidate) =>
      candidate.key === view.key && candidate.source === view.source,
  );
  if (!definition) throw new Error(`Unknown related view key: ${view.key}`);
  return connectedPathVariants(view.source, [definition.relationship]).map(
    (variant) => variant.steps,
  );
};

type RegisteredRelatedView = (typeof relatedViewRegistry)[number];

export const relatedViewsFor = (
  entity: Entity,
): readonly RegisteredRelatedView[] =>
  relatedViewRegistry.filter((view) => view.source === entity);

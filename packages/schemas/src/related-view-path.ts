import { localRelationshipByKey } from "./entity-manifest";
import {
  type RelatedViewDefinition,
  relatedViewRelationshipKeys,
} from "./related-view";

type RelatedViewRelationshipKey = keyof typeof relatedViewRelationshipKeys;
const isRelatedViewRelationshipKey = (
  key: string,
): key is RelatedViewRelationshipKey =>
  Object.hasOwn(relatedViewRelationshipKeys, key);

/**
 * The local relationship path a related view compiles to. Server-only: it
 * reads relationship provenance from the all-entities manifest, which the
 * browser never loads (docs/adr/0009-per-entity-client-manifests.md).
 */
export const relatedViewPath = (
  view: Pick<RelatedViewDefinition, "source" | "key">,
) => {
  if (!isRelatedViewRelationshipKey(view.key)) {
    throw new Error(`Unknown related view key: ${view.key}`);
  }
  const relationshipKey = relatedViewRelationshipKeys[view.key];
  return localRelationshipByKey(view.source, relationshipKey).provenance.steps;
};

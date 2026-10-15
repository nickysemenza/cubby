import type { CollectionActionId } from "@cubby/schemas/entity-definitions/collection-actions";
import type { ReportRecordRow } from "@cubby/schemas/entity-report";
import type { FunctionComponent, LazyExoticComponent } from "react";

import { featureRegistry } from "~/entity/feature-registry";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

/**
 * What a `collection` section hands an action: the loaded record, and for a `row` action the
 * row it was drawn on (`null` for a `section` action).
 */
export type CollectionActionProps<E extends GenericDetailEntity> = {
  record: DetailRecordOf<E>;
  item: ReportRecordRow | null;
};

/**
 * The web fill for every action a report `records` block can offer (native has a plan in
 * `nativeCollectionActionPlans`). Keyed by `CollectionActionId`, so a declared action without a
 * browser implementation fails to compile in `features/registry.tsx`. Each is lazy: a detail
 * route loads only the dialogs of the actions its own sections declare. A component reads the
 * record's entity, so the map is erased to `never` for the section that renders any of them.
 */
export type CollectionActionTable = Record<
  CollectionActionId,
  LazyExoticComponent<FunctionComponent<CollectionActionProps<never>>>
>;

export const collectionActionFor = (action: CollectionActionId) =>
  featureRegistry().collectionActions[action];

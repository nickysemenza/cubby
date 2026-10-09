import { mapRecord } from "@cubby/shared/record";

import type { Entity } from "./entity-core";
import {
  imagePolicyCatalog,
  type ImageDisplayBinding,
  type ImageIngressRoute,
} from "./generated/image-policy.gen";
import { entityKeys } from "./generated/entity-index.gen";

export {
  imagePolicyCatalog,
  photoCategories,
  type ImageDisplayBinding,
  type ImageIngressBinding,
  type ImageIngressRoute,
  type ImagePolicy,
  type ImageRoutingPolicy,
  type ImageStorage,
  type PhotoCategory,
} from "./generated/image-policy.gen";
export type { PhotoCategoryKey } from "./photo-categories";

export type ImageIngressRouteId =
  (typeof imagePolicyCatalog)[Entity]["ingress"][number]["routeId"];
/** Every entity's photo ingress routes by `routeId`, which the compiler keeps unique. */
export type ImageIngressRouteIndex = {
  [RouteId in ImageIngressRouteId]: ImageIngressRoute;
};
const routesById: Partial<ImageIngressRouteIndex> = {};
for (const policy of Object.values(imagePolicyCatalog))
  for (const route of policy.ingress) routesById[route.routeId] = route;
export const imageIngressRouteById: Readonly<ImageIngressRouteIndex> =
  // SAFETY: the loop above visits every catalog route, and
  // ImageIngressRouteId is exactly the union of those routes' routeIds.
  routesById as ImageIngressRouteIndex;
export const imageDisplayBindings: Record<
  Entity,
  readonly ImageDisplayBinding[]
> = mapRecord(
  entityKeys,
  (entity) => imagePolicyCatalog[entity].displaySources,
);

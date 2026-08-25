import type { Entity } from "@cubby/schemas/entity";
import { cookbookDetailQueryOptions } from "./cookbook.functions";
import { entityDetailQueryOptions } from "./entity-detail.functions";
import {
  type GeneratedBrowserCrudEntity,
  generatedBrowserCrudEntities,
} from "./generated/entity-routes.gen";
import { imageDetailQueryOptions } from "./image.functions";
import { usdaFoodDetailQueryOptions } from "./usda.functions";

export const fdcIdFromParam = (id: string): number => Number.parseInt(id, 10);
export const usdaRouteId = (fdcId: number): string => String(fdcId);

const isGeneratedBrowserCrudEntity = (
  entity: Entity,
): entity is GeneratedBrowserCrudEntity =>
  (generatedBrowserCrudEntities as readonly Entity[]).includes(entity);

/**
 * Map an entity + route id to its detail query options — the single source for
 * "how do I fetch entity X by id", owning the Start entity-detail path, USDA
 * route-id coercion and the explicit Image/Cookbook projections.
 */
export function entityPreviewQueryOptions(entity: Entity, id: string) {
  if (entity === "image") return imageDetailQueryOptions(id);
  if (entity === "usda-food") {
    return usdaFoodDetailQueryOptions(fdcIdFromParam(id));
  }
  if (entity === "cookbook") return cookbookDetailQueryOptions(id);
  if (isGeneratedBrowserCrudEntity(entity)) {
    return entityDetailQueryOptions(entity, id);
  }
  throw new Error(`Entity ${entity} has no browser detail transport`);
}

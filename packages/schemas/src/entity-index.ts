import { type Entity, entitySchema } from "./entity-core";
import { entityIndex } from "./generated/entity-index.gen";

export { entityIndex, entityKeys } from "./generated/entity-index.gen";
export type { EntityIndexEntry } from "./entity-index-types";
export {
  WAYFINDING_DOMAINS,
  WAYFINDING_DOMAIN_PRESENTATION,
} from "./entity-definitions/definition";
export type { WayfindingDomain } from "./entity-definitions/definition";

/**
 * The slim always-loaded entity index and the trait rosters derived from it.
 * Browser code (navigation, links, icons, list loaders, pickers) reads these;
 * one entity's field model, presentation and manifest descriptor load with its
 * own model module (`apps/web/src/entity/entity-model.ts`), and the
 * all-entities aggregates (`./entity-manifest`, `./entity-fields`,
 * `./generated/entity-summary.gen`) stay server-side
 * (docs/adr/0009-per-entity-client-manifests.md).
 */
export type EntityIndex = typeof entityIndex;

const isEntity = (value: string): value is Entity =>
  entitySchema.safeParse(value).success;

export const allEntities: readonly Entity[] =
  Object.keys(entityIndex).filter(isEntity);

/** The entities one entity's declared relationships point at. */
export const entityReferences = (entity: Entity): readonly Entity[] =>
  entityIndex[entity].references;

type BooleanTrait = {
  [K in keyof EntityIndex[Entity]]-?: EntityIndex[Entity][K] extends boolean
    ? K
    : never;
}[keyof EntityIndex[Entity]];
type EntityWithTrait<K extends BooleanTrait> = {
  [E in Entity]: EntityIndex[E] extends Record<K, true> ? E : never;
}[Entity];

const entitiesWithTrait = <K extends BooleanTrait>(
  trait: K,
): readonly EntityWithTrait<K>[] =>
  Object.freeze(
    allEntities.filter(
      (entity): entity is EntityWithTrait<K> =>
        entityIndex[entity][trait] === true,
    ),
  );

export const auditableEntities = entitiesWithTrait("auditable");
export const imageEntities = entitiesWithTrait("hasImages");
/** Entities whose public read rows carry server-resolved `displayImages`. */
export const displayImageEntities = entitiesWithTrait("displayImages");

type EntityWithImageStorage<S extends "gallery" | "cover" | "logo"> = {
  [E in Entity]: EntityIndex[E] extends { imageStorage: S } ? E : never;
}[Entity];
/** Entities whose images live in an ordered `<Entity>Image` join table. */
export type GalleryEntity = EntityWithImageStorage<"gallery">;
export const galleryEntities: readonly GalleryEntity[] = Object.freeze(
  allEntities.filter(
    (entity): entity is GalleryEntity =>
      entityIndex[entity].imageStorage === "gallery",
  ),
);
/** Entities whose single photo is one `cover` attachment. */
export type CoverEntity = EntityWithImageStorage<"cover">;
export const coverEntities: readonly CoverEntity[] = Object.freeze(
  allEntities.filter(
    (entity): entity is CoverEntity =>
      entityIndex[entity].imageStorage === "cover",
  ),
);
/** Entities whose single logo is one `logo` attachment. */
export type LogoEntity = EntityWithImageStorage<"logo">;
export const logoEntities: readonly LogoEntity[] = Object.freeze(
  allEntities.filter(
    (entity): entity is LogoEntity =>
      entityIndex[entity].imageStorage === "logo",
  ),
);
export const searchableEntities = entitiesWithTrait("searchable");
export const embeddableEntities = entitiesWithTrait("embeddable");
export const countableEntities = entitiesWithTrait("countable");

type EntityWithBrowserRoute = {
  [E in Entity]: EntityIndex[E] extends { browserRoutes: false } ? never : E;
}[Entity];
export const browserRoutedEntities: readonly EntityWithBrowserRoute[] =
  Object.freeze(
    allEntities.filter(
      (entity): entity is EntityWithBrowserRoute =>
        entityIndex[entity].browserRoutes,
    ),
  );

type EntityWithShortcode = {
  [E in Entity]: EntityIndex[E] extends { shortcodePrefix: string } ? E : never;
}[Entity];
export const shortcodeEntities: readonly EntityWithShortcode[] = Object.freeze(
  allEntities.filter(
    (entity): entity is EntityWithShortcode =>
      entityIndex[entity].shortcodePrefix !== null,
  ),
);

export type ShortcodeEntity = EntityWithShortcode;
export type BrowserRoutedEntity = EntityWithBrowserRoute;
export type AuditableEntity = (typeof auditableEntities)[number];
export type CountableEntity = (typeof countableEntities)[number];
export type SearchableEntity = (typeof searchableEntities)[number];
export type EmbeddableEntity = (typeof embeddableEntities)[number];

export const isAuditableEntity = (entity: Entity): entity is AuditableEntity =>
  entityIndex[entity].auditable;

export const isGalleryEntity = (entity: Entity): entity is GalleryEntity =>
  entityIndex[entity].imageStorage === "gallery";

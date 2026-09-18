import { z } from "zod";
import { type Entity, entitySchema } from "./entity-core";
export {
  entityInspectorMetadata,
  type EntityInspectorMetadata,
} from "./generated/entity-inspector.gen";
export {
  imageDisplayBindings,
  imageIngressRouteById,
  imageIngressRoutes,
  imageOwners,
  imagePolicyCatalog,
  type ImageDisplayBinding,
  type ImageIngressBinding,
  type ImageIngressRoute,
  type ImageIngressRouteId,
  type ImageOwner,
  type ImagePolicy,
  type ImageRoutingPolicy,
  type ImageStorage,
} from "./generated/image-policy.gen";
import { generatedEntityManifest } from "./generated/entity-manifest-data.gen";
import type { entitySummary } from "./generated/entity-summary.gen";
import { relatednessSignalSchema } from "./relatedness";
import {
  type EntityRelationship,
  entityLifecycleSchema,
  entityRelationshipSchema,
  type RelationshipPathStep,
} from "./entity-integrity";

const mcpOp = z.enum([
  "get",
  "list",
  "search",
  "create",
  "update",
  "delete",
  "bulkUpdate",
  "merge",
]);

const imageStorage = z.union([
  z.literal(false),
  z.enum(["gallery", "cover", "logo"]),
]);
const imagePolicy = z.object({
  storage: imageStorage,
  displaySources: z
    .array(
      z.object({
        relationPath: z.array(z.string()).readonly(),
        priority: z.number().int().nonnegative(),
        ordering: z.enum(["declared", "newest", "oldest"]),
        identityEvidence: z.literal(false),
      }),
    )
    .readonly(),
  ingress: z
    .array(
      z.object({
        kind: z.enum(["self", "existingRelated", "createRelated"]),
        routeId: z.string(),
        relationPath: z.array(z.string()).readonly().optional(),
        bindings: z.array(z.unknown()).readonly().optional(),
      }),
    )
    .readonly(),
  routing: z.unknown().nullable(),
});

export const entityDescriptor = z.object({
  dbTable: z.string().nullable(),
  idBrand: z.string().nullable(),
  shortcodePrefix: z.string().optional(),
  softDelete: z.boolean(),
  browserRoutes: z.boolean().optional(),
  auditable: z.boolean(),
  hasImages: z.boolean(),
  /** Manifest-owned storage, display fallback and importer route policy. */
  images: imagePolicy,
  /** How direct images attach; display imagery is resolved for every entity. */
  imageStorage: z.union([
    z.literal(false),
    z.enum(["gallery", "cover", "logo"]),
  ]),
  /**
   * Every list row carries a server-resolved `displayImages` array.
   */
  displayImages: z.boolean(),
  searchable: z.boolean(),
  /** Whether this searchable entity also gets an `EntityEmbedding` vector. */
  embeddable: z.boolean(),
  countable: z.boolean(),
  countFilter: z.enum(["recipeIdNull"]).optional(),
  relationships: z.array(entityRelationshipSchema).readonly(),
  relatednessSignals: z.array(relatednessSignalSchema).readonly().optional(),
  lifecycle: entityLifecycleSchema,
  mcp: z.array(mcpOp).readonly(),
  mcpNames: z
    .object({
      singular: z.string().optional(),
      plural: z.string().optional(),
      overrides: z.partialRecord(mcpOp, z.string()).optional(),
    })
    .optional(),
});
export type EntityDescriptor = z.infer<typeof entityDescriptor>;

/** Generated from `packages/schemas/src/entity-definitions/*.entity.ts`; do not add data here. */
export const entityManifest = generatedEntityManifest;
export type EntityManifest = typeof entityManifest;

const parsedEntityManifest = z
  .record(entitySchema, entityDescriptor)
  .parse(entityManifest);
const descriptorFor = (entity: Entity): EntityDescriptor =>
  parsedEntityManifest[entity];

const snakeCase = (entity: string) =>
  entity
    .replace(/-/g, "_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();

export const mcpEntityPlural = (entity: Entity): string => {
  const names = descriptorFor(entity).mcpNames;
  return names?.plural ?? `${names?.singular ?? snakeCase(entity)}s`;
};

export const mcpEntitySingular = (entity: Entity): string =>
  descriptorFor(entity).mcpNames?.singular ?? snakeCase(entity);

export const mcpToolName = (
  entity: Entity,
  operation: z.infer<typeof mcpOp>,
): string => {
  const names = descriptorFor(entity).mcpNames;
  return (
    names?.overrides?.[operation] ??
    `${operation}_${operation === "get" ? mcpEntitySingular(entity) : mcpEntityPlural(entity)}`
  );
};

export type LocalPathRelationship = EntityRelationship & {
  provenance: { kind: "local-path"; steps: readonly RelationshipPathStep[] };
};

export const localRelationshipByKey = (
  source: Entity,
  key: string,
): LocalPathRelationship => {
  const candidate = entityManifest[source].relationships.find(
    (relationship) => relationship.key === key,
  );
  if (candidate === undefined) {
    throw new Error(`Unknown local relationship ${source}.${key}`);
  }
  const relationship = entityRelationshipSchema.parse(candidate);
  if (relationship.provenance.kind !== "local-path") {
    throw new Error(`Unknown local relationship ${source}.${key}`);
  }
  return { ...relationship, provenance: relationship.provenance };
};

const isEntity = (value: string): value is Entity =>
  entitySchema.safeParse(value).success;

export const allEntities: readonly Entity[] =
  Object.keys(entityManifest).filter(isEntity);
export const entityReferences = (entity: Entity): readonly Entity[] => [
  ...new Set(
    entityManifest[entity].relationships.map(
      (relationship) => relationship.target,
    ),
  ),
];

type BooleanTrait = {
  [K in keyof EntityDescriptor]-?: NonNullable<
    EntityDescriptor[K]
  > extends boolean
    ? K
    : never;
}[keyof EntityDescriptor];
type EntityWithTrait<K extends BooleanTrait> = {
  [E in Entity]: EntityManifest[E] extends Record<K, true> ? E : never;
}[Entity];

const entitiesWithTrait = <K extends BooleanTrait>(
  trait: K,
): readonly EntityWithTrait<K>[] =>
  Object.freeze(
    allEntities.filter(
      (entity): entity is EntityWithTrait<K> =>
        descriptorFor(entity)[trait] === true,
    ),
  );

export const auditableEntities = entitiesWithTrait("auditable");
export const imageEntities = entitiesWithTrait("hasImages");
/** Entities whose public read rows carry server-resolved `displayImages`. */
export const displayImageEntities = entitiesWithTrait("displayImages");

type EntityWithImageStorage<S extends "gallery" | "cover" | "logo"> = {
  [E in Entity]: EntityManifest[E] extends { imageStorage: S } ? E : never;
}[Entity];
/** Entities whose images live in an ordered `<Entity>Image` join table. */
export type GalleryEntity = EntityWithImageStorage<"gallery">;
export const galleryEntities: readonly GalleryEntity[] = Object.freeze(
  allEntities.filter(
    (entity): entity is GalleryEntity =>
      descriptorFor(entity).imageStorage === "gallery",
  ),
);
/** Entities whose single photo lives in one `coverImageId` column. */
export type CoverEntity = EntityWithImageStorage<"cover">;
export const coverEntities: readonly CoverEntity[] = Object.freeze(
  allEntities.filter(
    (entity): entity is CoverEntity =>
      descriptorFor(entity).imageStorage === "cover",
  ),
);
/** Entities whose single logo lives in one `logoImageId` column. */
export type LogoEntity = EntityWithImageStorage<"logo">;
export const logoEntities: readonly LogoEntity[] = Object.freeze(
  allEntities.filter(
    (entity): entity is LogoEntity =>
      descriptorFor(entity).imageStorage === "logo",
  ),
);
export const searchableEntities = entitiesWithTrait("searchable");
export const embeddableEntities = entitiesWithTrait("embeddable");
export const countableEntities = entitiesWithTrait("countable");

type EntityWithBrowserRoute = {
  [E in Entity]: EntityManifest[E] extends { browserRoutes: false } ? never : E;
}[Entity];
export const browserRoutedEntities: readonly EntityWithBrowserRoute[] =
  Object.freeze(
    allEntities.filter(
      (entity): entity is EntityWithBrowserRoute =>
        descriptorFor(entity).browserRoutes !== false,
    ),
  );

type EntityWithShortcode = {
  [E in Entity]: EntityManifest[E] extends { shortcodePrefix: string }
    ? E
    : never;
}[Entity];
export const shortcodeEntities: readonly EntityWithShortcode[] = Object.freeze(
  allEntities.filter(
    (entity): entity is EntityWithShortcode =>
      descriptorFor(entity).shortcodePrefix !== undefined,
  ),
);

export type ShortcodeEntity = EntityWithShortcode;
export type BrowserRoutedEntity = EntityWithBrowserRoute;
export type AuditableEntity = (typeof auditableEntities)[number];
export type CountableEntity = (typeof countableEntities)[number];
export type SearchableEntity = (typeof searchableEntities)[number];
export type EmbeddableEntity = (typeof embeddableEntities)[number];

export const isAuditableEntity = (entity: Entity): entity is AuditableEntity =>
  entityManifest[entity].auditable;

export const isGalleryEntity = (entity: Entity): entity is GalleryEntity =>
  entityManifest[entity].imageStorage === "gallery";

/**
 * The slot ids an entity's `presentation` declares, as literal unions from
 * the generated summary: a renderer's slot registry is typed by these, so a
 * registry entry for an undeclared slot (or a declared slot spelled
 * differently) fails to compile.
 */
export type DetailSlotId<E extends Entity> = Extract<
  (typeof entitySummary)[E]["detail"]["sections"][number],
  { kind: "slot" }
>["id"];
export type ListSlotId<E extends Entity> = Extract<
  (typeof entitySummary)[E]["list"]["views"][number],
  { kind: "slot" }
>["id"];

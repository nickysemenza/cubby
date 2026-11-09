import { relatedRecordSignalSchema } from "./related-record-signals";
import { z } from "zod";
import { type Entity, entitySchema } from "./entity-core";
export {
  entityInspectorMetadata,
  type EntityInspectorMetadata,
} from "./generated/entity-record-metadata.gen";
import {
  imagePolicyCatalog,
  type ImageDisplayBinding,
  type ImageIngressRoute,
} from "./generated/image-policy.gen";
import { entityKeys } from "./generated/entity-summary.gen";
import type {
  auditableEntities,
  browserRoutedEntities,
  countableEntities,
  coverEntities,
  embeddableEntities,
  galleryEntities,
  logoEntities,
  searchableEntities,
  shortcodeEntities,
} from "./generated/entity-roster.gen";
import { mapRecord } from "@cubby/shared";
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
export type { PhotoCategoryKey } from "./photo-categories";
import { generatedEntityManifest } from "./generated/entity-manifest-data.gen";
export type {
  DetailRendererId,
  ListRendererId,
  ControlRendererId,
} from "./generated/entity-field-model.gen";
export type { DetailSlotId, ListSlotId } from "./generated/entity-summary.gen";
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
        kind: z.enum([
          "self",
          "existingRelated",
          "createRelated",
          "createSelf",
        ]),
        routeId: z.string(),
        // A conditional-primary route resolves to the enum at render time
        // (`ImageIngressRoute.choice`/`primaryWhen`); this re-validation of the raw
        // declaration still sees either shape (`imageIngressMetadataSchema`,
        // `packages/schemas/src/entity-definitions/definition.ts`).
        choice: z.union([
          z.enum(["primary", "alternate", "prompt"]),
          z.object({
            primary: z.object({
              when: z.object({
                field: z.string(),
                oneOf: z.array(z.string()),
              }),
            }),
            otherwise: z.enum(["alternate", "prompt"]),
          }),
        ]),
        relationPath: z.array(z.string()).readonly().optional(),
        bindings: z.array(z.unknown()).readonly().optional(),
        storage: imageStorage.optional(),
        enabled: z.boolean().optional(),
        disabledReason: z.string().optional(),
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
  relatednessSignals: z.array(relatedRecordSignalSchema).readonly(),
  countable: z.boolean(),
  relationships: z.array(entityRelationshipSchema).readonly(),
  lifecycle: entityLifecycleSchema,
  mcp: z.array(mcpOp).readonly(),
});
export type EntityDescriptor = z.infer<typeof entityDescriptor>;

/** Generated from `packages/schemas/src/entity-definitions/*.entity.ts`; do not add data here. */
export const entityManifest = generatedEntityManifest;
export type EntityManifest = typeof entityManifest;

export type LocalPathRelationship = EntityRelationship & {
  provenance: { kind: "local-path"; steps: readonly RelationshipPathStep[] };
};

export const relationshipByKey = (
  source: Entity,
  key: string,
): EntityRelationship => {
  const candidate = entityManifest[source].relationships.find(
    (relationship) => relationship.key === key,
  );
  if (candidate === undefined) {
    throw new Error(`Unknown local relationship ${source}.${key}`);
  }
  return entityRelationshipSchema.parse(candidate);
};

export const localRelationshipByKey = (
  source: Entity,
  key: string,
): LocalPathRelationship => {
  const relationship = relationshipByKey(source, key);
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

export {
  auditableEntities,
  browserRoutedEntities,
  countableEntities,
  coverEntities,
  displayImageEntities,
  embeddableEntities,
  galleryEntities,
  imageEntities,
  logoEntities,
  searchableEntities,
  shortcodeEntities,
} from "./generated/entity-roster.gen";
export { isAuditableEntity, isGalleryEntity } from "./entity-roster-runtime";

/** Entities whose images live in an ordered `<Entity>Image` join table. */
export type GalleryEntity = (typeof galleryEntities)[number];
/** Entities whose single photo is one `cover` attachment. */
export type CoverEntity = (typeof coverEntities)[number];
/** Entities whose single logo is one `logo` attachment. */
export type LogoEntity = (typeof logoEntities)[number];
export type ShortcodeEntity = (typeof shortcodeEntities)[number];
export type BrowserRoutedEntity = (typeof browserRoutedEntities)[number];
export type AuditableEntity = (typeof auditableEntities)[number];
export type CountableEntity = (typeof countableEntities)[number];
export type SearchableEntity = (typeof searchableEntities)[number];
export type EmbeddableEntity = (typeof embeddableEntities)[number];

export const entityMembership = <E extends string>(entities: readonly E[]) => {
  const members: readonly string[] = entities;
  return { has: (entity: string): entity is E => members.includes(entity) };
};

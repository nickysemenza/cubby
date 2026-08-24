import { z } from "zod";
import type { Entity } from "./entity-core";
export {
  entityInspectorMetadata,
  type EntityInspectorMetadata,
} from "./generated/entity-inspector.gen";
import { generatedEntityManifest } from "./generated/entity-manifest-data.gen";
import { relatednessSignalSchema } from "./relatedness";
import {
  type EntityRelationship,
  entityLifecycleSchema,
  entityRelationshipSchema,
  type RelationshipPathStep,
} from "./entity-integrity";

const mcpOp = z.enum(["get", "list", "create", "update", "delete"]);

export const entityDescriptor = z.object({
  dbTable: z.string().nullable(),
  idBrand: z.string().nullable(),
  shortcodePrefix: z.string().optional(),
  legacyShortcodePrefix: z.string().optional(),
  softDelete: z.boolean(),
  browserRoutes: z.boolean().optional(),
  auditable: z.boolean(),
  hasImages: z.boolean(),
  searchable: z.boolean(),
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

/** Generated from `scripts/entity-literals/entity-literals.ts`; do not add data here. */
export const entityManifest = generatedEntityManifest;
export type EntityManifest = typeof entityManifest;

const snakeCase = (entity: string) =>
  entity
    .replace(/-/g, "_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();

export const mcpEntityPlural = (entity: Entity): string => {
  const names: EntityDescriptor["mcpNames"] = (
    entityManifest[entity] as EntityDescriptor
  ).mcpNames;
  return names?.plural ?? `${names?.singular ?? snakeCase(entity)}s`;
};

export const mcpEntitySingular = (entity: Entity): string =>
  (entityManifest[entity] as EntityDescriptor).mcpNames?.singular ??
  snakeCase(entity);

export const mcpToolName = (
  entity: Entity,
  operation: z.infer<typeof mcpOp>,
): string => {
  const names = (entityManifest[entity] as EntityDescriptor).mcpNames;
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
  const relationship = entityManifest[source].relationships.find(
    (candidate) => candidate.key === key,
  );
  if (relationship?.provenance.kind !== "local-path") {
    throw new Error(`Unknown local relationship ${source}.${key}`);
  }
  return relationship as LocalPathRelationship;
};

export const allEntities = Object.keys(entityManifest) as Entity[];
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
        (entityManifest[entity] as EntityDescriptor)[trait] === true,
    ),
  );

export const auditableEntities = entitiesWithTrait("auditable");
export const imageEntities = entitiesWithTrait("hasImages");
export const searchableEntities = entitiesWithTrait("searchable");
export const countableEntities = entitiesWithTrait("countable");

type EntityWithBrowserRoute = {
  [E in Entity]: EntityManifest[E] extends { browserRoutes: false } ? never : E;
}[Entity];
export const browserRoutedEntities: readonly EntityWithBrowserRoute[] =
  Object.freeze(
    allEntities.filter(
      (entity): entity is EntityWithBrowserRoute =>
        (entityManifest[entity] as EntityDescriptor).browserRoutes !== false,
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
      (entityManifest[entity] as EntityDescriptor).shortcodePrefix !==
      undefined,
  ),
);

export type ShortcodeEntity = EntityWithShortcode;
export type BrowserRoutedEntity = EntityWithBrowserRoute;
export type AuditableEntity = (typeof auditableEntities)[number];
export type CountableEntity = (typeof countableEntities)[number];
export type SearchableEntity = (typeof searchableEntities)[number];

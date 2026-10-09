import { z } from "zod";
import { type Entity, entitySchema } from "./entity-core";
export {
  entityInspectorMetadata,
  type EntityInspectorMetadata,
} from "./generated/entity-inspector.gen";
export * from "./image-policies";
export * from "./entity-index";
import { generatedEntityManifest } from "./generated/entity-manifest-data.gen";
export type {
  DetailRendererId,
  ListRendererId,
  ControlRendererId,
} from "./generated/entity-field-model.gen";
export type { DetailSlotId, ListSlotId } from "./generated/entity-summary.gen";
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
  countable: z.boolean(),
  relationships: z.array(entityRelationshipSchema).readonly(),
  relatednessSignals: z.array(relatednessSignalSchema).readonly().optional(),
  lifecycle: entityLifecycleSchema,
  mcp: z.array(mcpOp).readonly(),
});
export type EntityDescriptor = z.infer<typeof entityDescriptor>;

/**
 * Generated from `packages/schemas/src/entity-definitions/*.entity.ts`; do not add data here.
 * The all-entities aggregate is server-side: browser code reads `./entity-index`
 * and one entity's loaded model (`cubby/no-client-entity-aggregate`).
 */
export const entityManifest = generatedEntityManifest;
export type EntityManifest = typeof entityManifest;

// Validates every generated descriptor once where the aggregate loads.
z.record(entitySchema, entityDescriptor).parse(entityManifest);

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

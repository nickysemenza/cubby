import type { Entity } from "./entity-core";
import type { EntityDescriptor } from "./entity-manifest";
import type { EntitySummary } from "./entity-summary-types";
import type {
  GeneratedEntityFieldModel,
  GeneratedListField,
  GeneratedRowSet,
  GeneratedInherit,
  GeneratedGroupChoice,
  GeneratedListScope,
  EntityInspectorMetadata,
} from "./entity-projection-types";
import type { GeneratedListTermKey } from "./generated/entity-list-fields.gen";
import type { z } from "zod";
export type StoredResultSchemas = Readonly<Record<string, z.ZodType>>;
export type TupleMember<T extends readonly string[]> = T[number];
export type TypeMap<T> = T;
export type EntityMetadataSlice = {
  entity: string;
  dependencies: readonly string[];
  descriptor: EntityDescriptor;
  summary: EntitySummary;
  fields: GeneratedEntityFieldModel;
  envelopeFields: readonly string[];
  relatedViews: unknown;
  connections: unknown;
  filterDescriptors: unknown;
  createDefaults: unknown;
  structuredSchemas: unknown;
  listFields: unknown;
  sort: unknown;
  editIntents: unknown;
};
export type EntityRosterData = Record<
  Entity,
  {
    singular: string;
    plural: string | null;
    icons: { phosphor: string; sfSymbol: string; emoji: string };
    domain: string | null;
    titleField: string;
    recordIconEntityField: string | null;
    recordEmojiField: string | null;
    merge: boolean;
    graph: boolean;
    shortcodePrefix: string | null;
    browserRoutes: boolean;
    hasImages: boolean;
    imageStorage: false | "gallery" | "cover" | "logo";
    searchable: boolean;
    embeddable: boolean;
    auditable: boolean;
    countable: boolean;
    displayImages: boolean;
  }
>;
export type MetadataEntityReadDependents = Record<Entity, readonly Entity[]>;
export type MetadataHomePinnedViews = readonly {
  entity: Entity;
  view: unknown;
}[];
export type MetadataGeneratedEntityManifest = Record<Entity, EntityDescriptor>;
export type MetadataEntitySummary = Record<Entity, EntitySummary>;
export type MetadataGeneratedEntityFieldModels = Record<
  Entity,
  GeneratedEntityFieldModel
>;
export type MetadataGeneratedEntityEditIntents = Partial<
  Record<
    Entity,
    {
      fields: Record<string, readonly string[]>;
      create: readonly string[];
      update: readonly [string, ...string[]];
      required: Record<string, readonly string[]>;
    }
  >
>;
export type MetadataGeneratedEntityListFields = Record<
  Entity,
  {
    derived: Record<string, GeneratedListField>;
    rows: Record<string, GeneratedRowSet>;
    terms: Record<string, GeneratedListTermKey>;
    inherit: Record<string, GeneratedInherit>;
    hierarchy: { parentField: string; column: string; maxDepth: number } | null;
    subtree: Record<string, string>;
    grouping: readonly GeneratedGroupChoice[];
    metrics: readonly {
      readonly key: string;
      readonly label: string;
      readonly format: string | null;
    }[];
    scope: readonly string[];
    scopes: Record<string, GeneratedListScope>;
  }
>;
export type MetadataGeneratedEntitySort = Partial<
  Record<
    Entity,
    {
      fields: readonly [string, ...string[]];
      default: string;
      direction: "asc" | "desc";
    }
  >
>;
export type MetadataEntityInspectorMetadata = Record<
  Entity,
  EntityInspectorMetadata
>;
export type MetadataGeneratedBrowserRoutes = Partial<
  Record<
    Entity,
    {
      basePath: string;
      routes: {
        detail: string;
        list: string;
        create?: "dialog" | "page";
        new?: string;
      };
    }
  >
>;

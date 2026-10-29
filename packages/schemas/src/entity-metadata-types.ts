import type { Entity } from "./entity-core";
import type { EntityDescriptor } from "./entity-manifest";
import type { EntitySummary } from "./entity-summary-types";
import type {
  EntityInspectorMetadata,
  GeneratedEntityFieldModel,
} from "./entity-projection-types";
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
export type MetadataEntityInspectorMetadata = Record<
  Entity,
  EntityInspectorMetadata
>;

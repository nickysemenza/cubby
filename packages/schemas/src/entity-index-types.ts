import type { Entity } from "./entity-core";
import type { CompiledEntityPresentation } from "./entity-definitions/definition";

/**
 * One entity's entry in the slim always-loaded index
 * (`generated/entity-index.gen.ts`): names, icons, wayfinding, record-mark
 * fields, capability traits, relationship targets, and the list's opening
 * views and filter. Everything heavier (field model, presentation, manifest
 * descriptor) is in the entity's own model module.
 */
export type EntityIndexEntry = Pick<
  CompiledEntityPresentation,
  | "titleField"
  | "domain"
  | "description"
  | "emptyState"
  | "recordEmojiField"
  | "recordIconEntityField"
  | "icons"
> & {
  singular: string;
  plural: string | null;
  primarySearch: { key: string; placeholder: string } | null;
  /** The kernel serves `merge`, so the generic merge verb applies. */
  merge: boolean;
  /** The manifest declares `capabilities.bulkUpdate`: the bulk-edit verb applies. */
  bulkUpdate: boolean;
  shortcodePrefix: string | null;
  dbTable: string | null;
  softDelete: boolean;
  browserRoutes: boolean;
  auditable: boolean;
  hasImages: boolean;
  imageStorage: false | "gallery" | "cover" | "logo";
  displayImages: boolean;
  searchable: boolean;
  embeddable: boolean;
  countable: boolean;
  /** Relationship targets, deduplicated, in declaration order. */
  references: readonly Entity[];
  /** Declared relations by key: their label and target entity, in declaration order. */
  relations: readonly { key: string; label: string; target: Entity }[];
  list: Pick<
    CompiledEntityPresentation["list"],
    "views" | "initialFilter" | "viewAliases"
  >;
};

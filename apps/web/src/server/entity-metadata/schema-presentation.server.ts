import type { Entity } from "@cubby/schemas/entity";
import {
  allEntities,
  entityDescriptor,
  photoCategories,
  type EntityDescriptor,
  type EntityInspectorMetadata,
  entityInspectorMetadata,
  entityManifest,
} from "@cubby/schemas/entity-manifest";
import { LEGACY_SHORTCODE_PREFIX } from "@cubby/shared";

import { entityOverrideComparisons } from "~/entity/generated/entity-override-comparisons.gen";
import {
  CRUD_SLOTS,
  type RelationDetail,
} from "~/entity/platform/entity-schema-model";
import { ENTITY_NATIVE_COVERAGE } from "~/lib/generated/entity-native-coverage.gen";

import { immutableMetadataSchema } from "./immutable-slice";

type Relationship = EntityDescriptor["relationships"][number];

function schemaSource(entity: Entity) {
  const expected: EntityInspectorMetadata = entityInspectorMetadata[entity];
  return {
    entity,
    descriptor: entityDescriptor.parse(entityManifest[entity]),
    metadata: immutableMetadataSchema(expected).parse(
      entityInspectorMetadata[entity],
    ),
  };
}

type SchemaSource = ReturnType<typeof schemaSource>;

type OverrideComparison = (typeof entityOverrideComparisons)[Entity][number];

function overridesFor(entity: Entity): readonly OverrideComparison[] {
  return entityOverrideComparisons[entity];
}

function emittedCode(metadata: EntityInspectorMetadata): string | null {
  const prefix = metadata.shortcodePrefix;
  return prefix ? `${prefix}XXXX` : null;
}

function legacyCode(entity: Entity): string | null {
  const prefix = Object.entries(LEGACY_SHORTCODE_PREFIX).find(
    ([, target]) => target === entity,
  )?.[0];
  return prefix ? `${prefix}XXXX` : null;
}

/** `list · get · update` plus a `+N rpc` suffix; null when the app never touches it. */
function nativeCoverageLabel(entity: Entity): string | null {
  const coverage = ENTITY_NATIVE_COVERAGE[entity];
  const actions = coverage.httpActions.join(" · ");
  const rpc = coverage.rpcIds.length ? `+${coverage.rpcIds.length} rpc` : "";
  return [actions, rpc].filter(Boolean).join(" ") || null;
}

/** The slots and fields native draws as a web handoff row; null when there are none. */
function nativeHandoffLabel(entity: Entity): string | null {
  const { handoffs } = ENTITY_NATIVE_COVERAGE[entity];
  return handoffs.length ? handoffs.join(" · ") : null;
}

type KernelAction = EntityInspectorMetadata["kernelActions"][number];

const CRUD_KNOWN_ACTIONS = new Set<KernelAction>(
  CRUD_SLOTS.flatMap((slot) => slot.needs),
);

function kernelSlots(metadata: EntityInspectorMetadata) {
  const actions = metadata.kernelActions;
  const supports = (needs: readonly KernelAction[]) =>
    needs.every((need) => actions.includes(need));
  return {
    crud: {
      create: supports(CRUD_SLOTS[0].needs),
      read: supports(CRUD_SLOTS[1].needs),
      update: supports(CRUD_SLOTS[2].needs),
      delete: supports(CRUD_SLOTS[3].needs),
    },
    extras: actions.filter((action) => !CRUD_KNOWN_ACTIONS.has(action)),
  };
}

/** Compiler reasons distinguish a list outside the inline-table operation
 * from an absent list page and from a hand-declared omission. */
const CUSTOM_LIST_SUFFIX =
  "has a list page, but its list cannot be used as an inline relation table.";
const NO_LIST_SUFFIX = "has no list page to render as a table.";

/**
 * Where a relation's detail table stands, per the compiled `detail` block:
 * `one`-cardinality relations never get a table (only `inverseOmit` explains
 * why no inverse exists); a `many` relation is `declared` when a hand-written
 * `kind:"relation"` section names it, `derived` when the compiler generated
 * that section, or an omitted status when `detail.omitRelations` records why
 * no section exists at all.
 */
function relationDetailStatus(
  metadata: EntityInspectorMetadata,
  relation: Relationship,
): RelationDetail {
  if (relation.cardinality === "one") {
    return { status: "one", reason: relation.inverseOmit };
  }
  const { sections, omitRelations } = metadata.detail;
  const section = sections.find(
    (candidate) =>
      candidate.kind === "relation" && candidate.relation === relation.key,
  );
  if (section && section.kind === "relation") {
    return {
      status: section.derived ? "derived" : "declared",
      descriptor: section.filter.descriptor,
    };
  }
  const reason = omitRelations[relation.key];
  if (reason) {
    return {
      status: reason.endsWith(CUSTOM_LIST_SUFFIX)
        ? "custom-list"
        : reason.endsWith(NO_LIST_SUFFIX)
          ? "no-list"
          : "omitted",
      reason,
    };
  }
  return {
    status: "omitted",
    reason: "not declared, not recorded as omitted",
  };
}

/** `shortcodePrefix` without its trailing dash — the stable abbreviation the
 * rest of the app already uses, reused as matrix headers. */
function abbrev({ entity, metadata }: SchemaSource): string {
  const prefix = metadata.shortcodePrefix;
  return prefix ? prefix.replace(/-$/, "") : entity.slice(0, 4).toUpperCase();
}

/** One flat, sortable row of effective behavior per entity: every value the
 * schema sheet shows as a column, so sorting and rendering read one shape. */
function schemaRow({ entity, metadata, descriptor }: SchemaSource) {
  const relationships = descriptor.relationships;
  const tables = { declared: 0, derived: 0, omitted: 0 };
  for (const relation of relationships) {
    if (relation.cardinality === "one") continue;
    const { status } = relationDetailStatus(metadata, relation);
    if (status === "declared") tables.declared += 1;
    else if (status === "derived") tables.derived += 1;
    else tables.omitted += 1;
  }
  const one = relationships.filter(
    (relation) => relation.cardinality === "one",
  ).length;
  const { crud, extras } = kernelSlots(metadata);
  return {
    entity,
    domain: metadata.domain,
    code: emittedCode(metadata),
    legacy: legacyCode(entity),
    table: descriptor.dbTable ?? null,
    countable: descriptor.countable,
    crud,
    extras,
    search: !metadata.searchable
      ? null
      : descriptor.embeddable
        ? ("semantic" as const)
        : ("lexical" as const),
    /** Served by its own workflow, with no kernel repository (USDA). */
    external: metadata.ports.repository === null,
    one,
    many: relationships.length - one,
    tables,
    filters: metadata.filterDescriptors.length,
    idFilters: metadata.filterDescriptors.filter(
      (filter) => filter.kind === "idMulti",
    ).length,
    deleteMode: metadata.lifecycle.delete?.mode ?? null,
    merge: metadata.lifecycle.merge,
    mcpOwner: metadata.mcpOwner,
    mcpOperations: metadata.mcpOperations,
    overrides: overridesFor(entity).length,
    sections: metadata.detail.sections.length,
    native: nativeCoverageLabel(entity),
    nativeHandoffs: nativeHandoffLabel(entity),
  };
}

function schemaTotals(sources: readonly SchemaSource[]) {
  return {
    declared: sources.length,
    crud: sources.filter(({ metadata }) => metadata.kernelActions.length > 0)
      .length,
    search: sources.filter(({ metadata }) => metadata.searchable).length,
    mcp: sources.filter(({ metadata }) => metadata.mcpOperations.length > 0)
      .length,
    ports: sources.filter(({ metadata }) => metadata.ports.repository !== null)
      .length,
    overrides: sources.reduce(
      (sum, { entity }) => sum + overridesFor(entity).length,
      0,
    ),
  };
}

/** The schema sheet receives presentation data, never the universal catalogs or
 * ordinary list/editor metadata slices. This module is demand-loaded by Start. */
export function loadSchemaOverview() {
  const sources = allEntities.map(schemaSource);
  const expected = {
    rows: sources.map(schemaRow),
    totals: schemaTotals(sources),
    graph: sources.map((source) => ({
      entity: source.entity,
      abbreviation: abbrev(source),
      relationships: source.descriptor.relationships.map((relation) => ({
        key: relation.key,
        target: relation.target,
        cardinality: relation.cardinality,
        detail: relationDetailStatus(source.metadata, relation),
      })),
    })),
    photos: Object.values(photoCategories).map((category) => ({
      key: category.key,
      emoji: category.emoji,
      label: category.label,
      entities: category.entities,
      classifierLabels: category.classifierLabels,
    })),
  };
  return immutableMetadataSchema(expected).parse(expected);
}

/** Comparisons are large source reports: admit them only for their own sheet. */
export function loadSchemaOverrides() {
  const expected = allEntities.flatMap((entity) =>
    overridesFor(entity).map((comparison) => ({ entity, ...comparison })),
  );
  return immutableMetadataSchema(expected).parse(expected);
}

/** Only the visible inspector crosses the wire. Each nested projection lists
 * exactly what its table renders, without field models, filters or saved-view plans. */
export function loadSchemaEntity(entity: Entity) {
  const source = schemaSource(entity);
  const { metadata, descriptor } = source;
  const expected = {
    row: schemaRow(source),
    description: metadata.description,
    repository: metadata.ports.repository,
    detail: {
      variant: metadata.detail.variant,
      sections: metadata.detail.sections.map(
        ({ id, kind, title, placement }) => ({
          id,
          kind,
          title,
          placement,
        }),
      ),
    },
    filters: metadata.filterDescriptors.map(
      ({ urlKey, kind, field, label }) => ({
        urlKey,
        kind,
        field,
        label,
      }),
    ),
    savedViews: metadata.list.savedViews.map(({ label }) => ({ label })),
    relationships: descriptor.relationships.map((relation) => ({
      key: relation.key,
      target: relation.target,
      cardinality: relation.cardinality,
      derived: relation.derived,
      label: relation.label,
      detail: relationDetailStatus(metadata, relation),
    })),
    overrides: overridesFor(entity),
  };
  return immutableMetadataSchema(expected).parse(expected);
}

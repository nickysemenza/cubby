import type { Entity } from "@cubby/schemas/entity";
import { allEntities, entityIndex } from "@cubby/schemas/entity-index";
import type {
  EntityDescriptor,
  EntityInspectorMetadata,
} from "@cubby/schemas/entity-manifest";
import { LEGACY_SHORTCODE_PREFIX } from "@cubby/shared/shortcode";

import type { EntityInspectorHealth } from "~/entity/entity-inspector-health";
import {
  entityDescriptorOf,
  entityInspector,
  useEntityInspectors,
  useEntityModels,
} from "~/entity/entity-model";
import { entityOverrideComparisons } from "~/entity/generated/entity-override-comparisons.gen";
import { ENTITY_NATIVE_COVERAGE } from "~/lib/generated/entity-native-coverage.gen";

/**
 * The schema surfaces read every entity's model and inspector, so their root
 * components suspend on `useEntityModels(allEntities)` and
 * `useEntityInspectors(allEntities)` before calling these.
 *
 * `entityDescriptorOf(entity)`'s generated literal type omits an `optional()`
 * schema key entirely for an entity that leaves it unset, rather than typing
 * it `| undefined` — so a union-wide read of `relationships[i].derived` /
 * `.inverseOmit` doesn't type-check against every member. Widen back to the
 * zod-inferred shape, which `parsedEntityManifest` in `entity-manifest.ts`
 * already verifies every entry satisfies.
 */
export function useSchemaSurfaceModels(): void {
  useEntityModels(allEntities);
  useEntityInspectors(allEntities);
}

export function extendedManifest(entity: Entity): EntityDescriptor {
  // SAFETY: see doc comment above — every generated descriptor
  // satisfies `entityDescriptor`, just not through a type TS can see here.
  return entityDescriptorOf(entity) as EntityDescriptor;
}

export type Relationship = EntityDescriptor["relationships"][number];

/**
 * Same widening trap as `extendedManifest`, one level up: `entityInspector(entity)`
 * indexed by the union `Entity` type collapses tuple-typed fields
 * (`kernelActions`, `detail.sections`, …) to `never` because each entity's
 * generated literal narrows them differently. Widen back to the exported
 * `EntityInspectorMetadata` shape.
 */
export function metadataFor(entity: Entity): EntityInspectorMetadata {
  // SAFETY: see doc comment above — every entity's generated record already
  // satisfies `EntityInspectorMetadata`, just not through a type TS can see
  // when indexed by a union key.
  return entityInspector(entity) as EntityInspectorMetadata;
}

export type OverrideComparison =
  (typeof entityOverrideComparisons)[Entity][number];

export function overridesFor(entity: Entity): readonly OverrideComparison[] {
  return entityOverrideComparisons[entity];
}

function emittedCode(entity: Entity): string | null {
  const prefix = metadataFor(entity).shortcodePrefix;
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

type KernelAction = EntityInspectorMetadata["kernelActions"][number];

/** The four CRUD slots; `read` needs both `get` and `list`. Anything else a
 * kernel declares (`search`, `bulkUpdate`, `merge`, `resolve`) is an extra. */
export const CRUD_SLOTS = [
  { key: "create", code: "C", needs: ["create"] },
  { key: "read", code: "R", needs: ["get", "list"] },
  { key: "update", code: "U", needs: ["update"] },
  { key: "delete", code: "D", needs: ["delete"] },
] as const satisfies readonly {
  key: string;
  code: string;
  needs: readonly KernelAction[];
}[];
const CRUD_KNOWN_ACTIONS = new Set<KernelAction>(
  CRUD_SLOTS.flatMap((slot) => slot.needs),
);

type CrudSlot = (typeof CRUD_SLOTS)[number]["key"];

function kernelSlots(entity: Entity) {
  const actions = metadataFor(entity).kernelActions;
  return {
    // SAFETY: `Object.fromEntries` over `CRUD_SLOTS` yields exactly one
    // boolean per slot key, which is the whole `Record<CrudSlot, boolean>`.
    crud: Object.fromEntries(
      CRUD_SLOTS.map((slot) => [
        slot.key,
        slot.needs.every((need) => actions.includes(need)),
      ]),
    ) as Record<CrudSlot, boolean>,
    extras: actions.filter((action) => !CRUD_KNOWN_ACTIONS.has(action)),
  };
}

type RelationDetailStatus =
  | "declared"
  | "derived"
  | "omitted"
  | "custom-list"
  | "no-list"
  | "one";

/** Compiler reasons distinguish a list outside the inline-table operation
 * from an absent list page and from a hand-declared omission. */
const CUSTOM_LIST_SUFFIX =
  "has a list page, but its list cannot be used as an inline relation table.";
const NO_LIST_SUFFIX = "has no list page to render as a table.";

export const DETAIL_STATUS_LABEL = {
  declared: "declared",
  derived: "derived",
  omitted: "omitted",
  "custom-list": "custom list",
  "no-list": "no list",
  one: "—",
} satisfies Record<RelationDetailStatus, string>;

export type RelationDetail = {
  status: RelationDetailStatus;
  reason?: string;
  descriptor?: string;
};

/**
 * Where a relation's detail table stands, per the compiled `detail` block:
 * `one`-cardinality relations never get a table (only `inverseOmit` explains
 * why no inverse exists); a `many` relation is `declared` when a hand-written
 * `kind:"relation"` section names it, `derived` when the compiler generated
 * that section, or an omitted status when `detail.omitRelations` records why
 * no section exists at all.
 */
export function relationDetailStatus(
  entity: Entity,
  relation: Relationship,
): RelationDetail {
  if (relation.cardinality === "one") {
    return { status: "one", reason: relation.inverseOmit };
  }
  const { sections, omitRelations } = metadataFor(entity).detail;
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

export function relationStatusClass(status: RelationDetailStatus): string {
  switch (status) {
    case "declared":
      return "text-foreground";
    case "derived":
      return "text-primary";
    case "omitted":
      return "text-destructive";
    case "custom-list":
    case "no-list":
      return "text-muted-foreground/50";
    case "one":
      return "text-muted-foreground/30";
  }
}

export const RELATION_STATUS_LEGEND: readonly [RelationDetailStatus, string][] =
  [
    ["declared", "declared detail table"],
    ["derived", "compiler-derived detail table"],
    ["omitted", "explicitly omitted"],
    ["custom-list", "custom list; no inline relation table"],
    ["no-list", "target has no list page"],
    ["one", "one-cardinality (no table)"],
  ];

/** `shortcodePrefix` without its trailing dash — the stable abbreviation the
 * rest of the app already uses, reused as matrix headers. */
export function abbrev(entity: Entity): string {
  const prefix = metadataFor(entity).shortcodePrefix;
  return prefix ? prefix.replace(/-$/, "") : entity.slice(0, 4).toUpperCase();
}

/** One flat, sortable row of effective behavior per entity: every value the
 * schema sheet shows as a column, so sorting and rendering read one shape. */
export function schemaRow(
  entity: Entity,
  counts: EntityInspectorHealth["counts"] | undefined,
) {
  const metadata = metadataFor(entity);
  const relationships = extendedManifest(entity).relationships;
  const tables = { declared: 0, derived: 0, omitted: 0 };
  for (const relation of relationships) {
    if (relation.cardinality === "one") continue;
    const { status } = relationDetailStatus(entity, relation);
    if (status === "declared") tables.declared += 1;
    else if (status === "derived") tables.derived += 1;
    else tables.omitted += 1;
  }
  const one = relationships.filter(
    (relation) => relation.cardinality === "one",
  ).length;
  const { crud, extras } = kernelSlots(entity);
  return {
    entity,
    domain: metadata.domain,
    code: emittedCode(entity),
    legacy: legacyCode(entity),
    table: entityIndex[entity].dbTable ?? null,
    rows: entityIndex[entity].countable ? counts?.[entity] : undefined,
    crud,
    extras,
    search: !metadata.searchable
      ? null
      : entityIndex[entity].embeddable
        ? ("semantic" as const)
        : ("lexical" as const),
    /** Served by its own workflow, with no kernel repository (USDA). */
    external: metadata.ports.repository === null,
    one,
    many: relationships.length - one,
    tables,
    filters: metadata.filterDescriptors.length,
    idFilters: metadata.filterDescriptors.filter(
      (filter) => filter.kind === "id" || filter.kind === "idMulti",
    ).length,
    deleteMode: metadata.lifecycle.delete?.mode ?? null,
    merge: metadata.lifecycle.merge,
    mcpOwner: metadata.mcpOwner,
    mcpOperations: metadata.mcpOperations,
    overrides: overridesFor(entity).length,
    sections: metadata.detail.sections.length,
    native: nativeCoverageLabel(entity),
  };
}

export type SchemaRow = ReturnType<typeof schemaRow>;

export function schemaTotals() {
  return {
    declared: allEntities.length,
    crud: allEntities.filter(
      (entity) => metadataFor(entity).kernelActions.length > 0,
    ).length,
    search: allEntities.filter((entity) => metadataFor(entity).searchable)
      .length,
    mcp: allEntities.filter(
      (entity) => metadataFor(entity).mcpOperations.length > 0,
    ).length,
    ports: allEntities.filter(
      (entity) => metadataFor(entity).ports.repository !== null,
    ).length,
    overrides: allEntities.reduce(
      (sum, entity) => sum + overridesFor(entity).length,
      0,
    ),
  };
}

import type { GeneratedEntityFieldModel } from "@cubby/schemas/entity-projection-types";
import type { CompiledEntityListFields } from "./list-fields.ts";
import type { ChildTableMetadata } from "@cubby/schemas/compiler/entity-definitions/child-definition";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileEntityDeclarations } from "./compile.ts";
import { modulesChildren } from "@cubby/schemas/compiler/child-tables/modules";
import { validatePredicateBaseline } from "./predicate-baseline.ts";
import type {
  CompiledEntityPresentation,
  EntityDeclarationMetadata,
  EntityFieldModelMetadata,
  EntityFieldKind,
  EntityStorageDefaultKind,
} from "@cubby/schemas/entity-definitions/definition";
import { z } from "zod";

import { EntityDeclarationError, SPEC_DIRECTORY } from "./source.ts";
export { EntityDeclarationError } from "./source.ts";

export type DeclarationValue =
  | string
  | number
  | boolean
  | null
  | DeclarationObject
  | z.ZodType
  | DeclarationValue[];
export interface DeclarationObject {
  [key: string]: DeclarationValue;
}

export type SourceRef = Readonly<{ module: string; export: string }>;
type ParsedEntityRoute = {
  basePath: string;
  detailParam?: string;
  create?: "dialog" | "page";
  list: true | null;
  listColumns?: SourceRef;
  detail: true | null;
};
/** The list-route query parameter(s) a filter descriptor binds to. */
type FilterWire =
  | Readonly<{ kind: "param"; name: string }>
  | Readonly<{ kind: "range"; from: string; to: string; presence?: string }>;
/** Public entity filter values are always shortcodes. */
type IdentifierRef = Readonly<{ entity: string }>;
export type FilterDescriptor = Readonly<{
  columnId: string;
  field: string | null;
  urlKey: string;
  kind: "text" | "multiselect" | "presence" | "boolean" | "idMulti" | "range";
  placeholder: string;
  options:
    | readonly Readonly<{
        value: string;
        label: string;
        meta?: boolean;
        color?: string;
        role?: "status" | "category";
        glyph?: Readonly<{ phosphor: string; sfSymbol: string }>;
        expand?: Readonly<Record<string, string | number | boolean>>;
      }>[]
    | null;
  optionsRef: SourceRef | null;
  optionsKey: string | null;
  label: string | null;
  schemaDescription: string | null;
  deriveSchema: boolean;
  schemaFromRead: boolean;
  brandRef: IdentifierRef | null;
  expandRef: SourceRef | null;
  schemaRef: SourceRef | null;
  stored: Readonly<{ columns: readonly string[]; array: boolean }> | null;
  /**
   * The list fields a text filter matches any of: a stored model field or a
   * `model.derived` key (`via` or a text value).
   */
  anyOf:
    | readonly Readonly<{ key: string; source: "field" | "derived" }>[]
    | null;
  /**
   * The `model.derived` key the filter compiles through (`columnId` unless
   * the declaration names another), or null for a stored/hand-written filter.
   */
  derived: string | null;
  range: Readonly<{
    kind: "number" | "date";
    int: boolean;
    nonnegative: boolean;
    finite: boolean;
    describe: Readonly<{ lower: string; upper: string }> | null;
  }> | null;
  /** The Any value / No value request key (`presenceFilter`). */
  nullable: Readonly<{ field: string; label: string }> | null;
  /** The Match all request key of a multi-valued compiled filter. */
  match: Readonly<{ field: string }> | null;
  /**
   * The Exclude request key of a value filter, and the reason derived from
   * the declaration when the filter cannot exclude (a predicate that is not
   * `negatable`): clients disable "is not" with it and the list rejects it.
   */
  exclude: Readonly<{ field: string; reason: string | null }> | null;
  /** The generated "Include sub-…" toggle's request key. */
  subtree: string | null;
  /** Accepts `@me` (ADR 0018). */
  currentMember: boolean;
  /** The declared reason this filter accepts one value, not an any-of. */
  singleValue: string | null;
  /** Single-value scopes that share one value between them. */
  exclusiveGroup: string | null;
  /**
   * The list-column filter this one duplicates (the same request field
   * under an older deep-link key); the URL codec reads it into that state.
   */
  aliasOf: string | null;
  sentinels: readonly Readonly<{ value: string; label: string }>[] | null;
  wire: FilterWire;
  /**
   * The declared `listTermExpanders` key of a text filter; server-only, so
   * `compileListFields` moves it into `listFields.terms`.
   */
  terms?: string;
}>;
/**
 * A date range filter's bound keys, which accept relative date tokens and
 * the `from..to` bounds value: a range declared `date`, or the From/To wire
 * names `filterWire` gives dates (numbers bind Min/Max). Null for any other
 * filter.
 */
export const dateRangeBounds = (
  descriptor: FilterDescriptor,
): Readonly<{ from: string; to: string }> | null => {
  if (descriptor.kind !== "range" || descriptor.wire.kind !== "range")
    return null;
  const { from, to } = descriptor.wire;
  const dates =
    descriptor.range === null
      ? from.endsWith("From") && to.endsWith("To")
      : descriptor.range.kind === "date";
  return dates ? { from, to } : null;
};

export type EntityPorts = Readonly<{
  repository: SourceRef | null;
  references: Readonly<{ label: SourceRef | null; resolver: SourceRef | null }>;
  filters: SourceRef | null;
  search: Readonly<{
    projection: SourceRef | null;
    semanticText: SourceRef | null;
  }>;
  timeline: SourceRef | null;
}>;
type RelationList = Pick<
  RelationMutation,
  "entity" | "relation" | "rowSchema" | "adapter"
>;
export type RelationMutation = Readonly<{
  entity: string;
  relation: string;
  target: string;
  source: string;
  itemSchema: SourceRef;
  rowSchema: SourceRef;
  adapter: SourceRef;
  audiences: readonly ("browser" | "mcp")[];
}>;
type OperationOwner = "kernel" | "workflow" | null;
type EntityFieldResolutionValue =
  | string
  | number
  | boolean
  | null
  | readonly EntityFieldResolutionValue[]
  | EntityFieldResolutionObject;
interface EntityFieldResolutionObject {
  readonly [key: string]: EntityFieldResolutionValue;
}
type ProjectedEntityField = GeneratedEntityFieldModel<string>["fields"][number];
export type EntityField = Readonly<
  Omit<ProjectedEntityField, "requiredOnCreate" | "resolution"> & {
    resolution: Readonly<{
      reset?: Readonly<Record<string, EntityFieldResolutionValue>>;
      none: Readonly<Record<string, EntityFieldResolutionValue>> | null;
      redundancy: "eligible" | "intentional";
      confirm: Readonly<Record<string, EntityFieldResolutionValue>> | null;
      labels: Readonly<{ none?: string; unresolved?: string }> | null;
      inherit?: EntityFieldInherit;
    }> | null;
    validation: Readonly<{
      read: z.ZodType | null;
      create: z.ZodType | null;
      update: z.ZodType | null;
    }>;
  }
>;

type EntityFieldInherit = Readonly<{
  mode?: Readonly<{
    field: string;
    inherit: string;
    none?: readonly string[];
    explicitIfSet?: true;
  }>;
  from: readonly (
    | "hierarchy"
    | Readonly<{ hierarchy: Readonly<{ whileSame: string }> }>
    | Readonly<{ path: string }>
  )[];
}>;

export type EntityStorageField = Readonly<{
  key: string;
  column: string;
  kind: EntityFieldKind;
  nullable: boolean;
  default: EntityStorageDefaultKind;
  defaultValue: DeclarationValue;
  reference: string | null;
  referenceOptions?: Readonly<{
    column: string;
    onUpdate?:
      | "cascade"
      | "restrict"
      | "no action"
      | "set null"
      | "set default";
  }>;
  defaultSql?: string;
  specialized: string | null;
}>;
type EntityFieldModelSort = Readonly<{
  fields: readonly [string, ...string[]];
  default: string;
  direction: "asc" | "desc";
}>;
type EntityEditIntents = Readonly<{
  fields: Readonly<Record<string, readonly string[]>>;
  create: readonly string[];
  update: readonly string[];
  editorFields: readonly string[];
  required: Readonly<Record<string, readonly string[]>>;
}>;
export type EntityFieldModel = Readonly<{
  research?: EntityFieldModelMetadata["research"];
  fields: readonly EntityField[];
  storage: readonly EntityStorageField[];
  create: readonly string[];
  update: readonly string[];
  bulk: readonly string[];
  audit: readonly string[];
  output: readonly string[];
  sort: EntityFieldModelSort | null;
  /** `model.derived`: list fields that are not table columns. */
  derived: Readonly<
    Record<string, EntityFieldModelMetadata["derived"][string]>
  >;
  /** `model.rows`: to-many row sets a `via` may start at. */
  rows: Readonly<Record<string, EntityFieldModelMetadata["rows"][string]>>;
  hierarchy: Readonly<{ parentField: string; maxDepth: number }> | null;
  /** `model.grouping`: the Group by choices, compiled in `list-fields.ts`. */
  grouping: readonly string[];
  groupingOmit?: readonly string[];
  intents: EntityEditIntents | null;
}>;
/** An operational column the table stores with no model field. */
export type EntityTableColumn = Readonly<{
  key: string;
  kind: "text" | "identifier" | "timestamp" | "json";
  notNull: boolean;
  defaultValue: string | null;
  /** An entity key, or `user`. */
  reference: string | null;
  type: SourceRef | null;
}>;
/** SQL with `{columnKey}` placeholders the renderer binds to table columns. */
type EntityTableSql = string;
export type EntityTableIndex = Readonly<{
  name: string;
  unique: boolean;
  using: "btree" | "gin";
  on: readonly Readonly<
    { column: string; desc: boolean } | { sql: EntityTableSql }
  >[];
  where: EntityTableSql | null;
}>;
export type EntityTableCheck = Readonly<{
  name: string;
  sql: EntityTableSql;
  /** Verbatim SQL with bare `"column"` identifiers (`sql.raw`), no placeholders. */
  bare: boolean;
}>;
export type EntityTableRelation = Readonly<
  | {
      kind: "one";
      name: string;
      /** A Drizzle table export, or the entity a reference column names. */
      target: Readonly<{ table: string } | { entity: string }>;
      fields: readonly string[];
      references: readonly string[];
      relationName: string | null;
    }
  | {
      kind: "many";
      name: string;
      target: Readonly<{ table: string }>;
      relationName: string | null;
    }
>;
export type CompiledEntityTable = Readonly<{
  /** The SQL table name. */
  name: string;
  /** The Drizzle export (`lowerFirst(name)`): `inventoryEntry`, `product`. */
  exportName: string;
  columns: readonly EntityTableColumn[];
  indexes: readonly EntityTableIndex[];
  checks: readonly EntityTableCheck[];
  relations: readonly EntityTableRelation[];
}>;
export type CompiledPresentation = CompiledEntityPresentation;
export type CompiledEntity = Readonly<{
  key: string;
  overrides: readonly Readonly<{ path: string; value: string }>[];
  shortcode: string | null;
  /** Names plus the declaration's `presentation` block, passed through as one unit. */
  inspector: Readonly<
    { singular: string; plural: string | null } & CompiledPresentation
  >;
  /** `capabilities.timeline`: how `resources.<entity>.timeline` is served. */
  timeline: "default" | "custom" | null;
  descriptor: DeclarationObject;
  contract: Readonly<{
    create: SourceRef | null;
    update: SourceRef | null;
    output: SourceRef;
    list: SourceRef;
    detail: SourceRef;
    mcpOutput: SourceRef;
    mcpList: SourceRef;
    mcpDetail: SourceRef;
  }> | null;
  route: Readonly<ParsedEntityRoute> | null;
  filterAudit: boolean;
  filterUrlKeys: readonly string[];
  filterSchema: SourceRef | null;
  filterDescriptors: readonly FilterDescriptor[];
  /** Fields derived from ordinary updates and identity semantics; null without eligible updates. */
  bulkUpdateFields: readonly string[] | null;
  ports: EntityPorts;
  /** The manifest-owned image storage, display, ingress and routing policy. */
  imagePolicy: EntityDeclarationMetadata["capabilities"]["images"];
  relations: EntityDeclarationMetadata["relations"];
  relationMutations: readonly RelationMutation[];
  relationLists: readonly RelationList[];
  lifecycle: Readonly<{
    softDelete: boolean;
    delete: DeclarationValue | null;
    merge: boolean;
    /** `capabilities.lifecycle: "readOnly"` — the kernel serves reads only. */
    readOnly: boolean;
  }>;
  /** `capabilities.resolve`, or null when the entity has no resolve action. */
  resolve: EntityDeclarationMetadata["capabilities"]["resolve"];
  mcpActions: readonly string[];
  operationOwners: Readonly<{
    delete: OperationOwner;
    merge: OperationOwner;
  }>;
  fieldModel: EntityFieldModel;
  /** `presentation.list.scope`/`scopes` as declared; server-only. */
  listScopes: Readonly<{
    scope: readonly string[];
    scopes: Readonly<
      Record<string, Readonly<{ via: string; filters: string }>>
    >;
  }>;
  /** Compiled `model.derived`, hierarchy, and generated subtree toggles. */
  listFields: CompiledEntityListFields;
  /** The entity's own table, or null for a table-less entity (usda-food). */
  table: CompiledEntityTable | null;
  children: readonly ChildTableMetadata[];
  /** `capabilities.dataQuality`, or null for an unscored entity. */
  dataQuality: EntityDeclarationMetadata["capabilities"]["dataQuality"];
  /** `capabilities.classificationPolicies`; validated cross-entity. */
  classificationPolicies: EntityDeclarationMetadata["capabilities"]["classificationPolicies"];
}>;

export type { EntityArtifacts } from "../artifacts.ts";

const isDeclarationObject = (value: unknown): value is DeclarationObject =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof z.ZodType);

const isNonEmptyString = (value: DeclarationValue): value is string =>
  typeof value === "string" && value.length > 0;

const isBoolean = (value: DeclarationValue): value is boolean =>
  typeof value === "boolean";

export const objectValue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This compiler boundary validates imported declaration values before consuming them.
  value: unknown,
  context: string,
): DeclarationObject => {
  if (!isDeclarationObject(value)) {
    throw new EntityDeclarationError(`${context} must be an object.`);
  }
  return value;
};

export const required = (
  object: DeclarationObject,
  key: string,
  context: string,
) => {
  if (!(key in object)) {
    throw new EntityDeclarationError(`${context}.${key} is required.`);
  }
  const value = object[key];
  if (value === undefined) {
    throw new EntityDeclarationError(
      `${context}.${key} must not be undefined.`,
    );
  }
  return value;
};

export const stringValue = (
  value: DeclarationValue,
  context: string,
): string => {
  if (!isNonEmptyString(value)) {
    throw new EntityDeclarationError(`${context} must be a non-empty string.`);
  }
  return value;
};

export const booleanValue = (
  value: DeclarationValue,
  context: string,
): boolean => {
  if (!isBoolean(value)) {
    throw new EntityDeclarationError(`${context} must be a boolean.`);
  }
  return value;
};

export const declarationModules = new Map<
  string,
  { path: string; enumExports: string[] }
>();

export const compileLoadedEntityDeclarations = (
  loaded: readonly DeclarationObject[],
): CompiledEntity[] => {
  return compileEntityDeclarations(loaded, modulesChildren);
};

export const loadEntityDeclarationBundle = async (): Promise<{
  entities: CompiledEntity[];
  declarations: DeclarationObject[];
}> => {
  const entries = (await readdir(SPEC_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".entity.ts"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0)
    throw new EntityDeclarationError(
      `${SPEC_DIRECTORY} has no entity declarations.`,
    );
  const loaded = await Promise.all(
    entries.map(async (entry) => {
      const module = await import(
        pathToFileURL(resolve(SPEC_DIRECTORY, entry.name)).href
      );
      const raw = objectValue(module.default, entry.name);
      // Filter schemas are generated from descriptors (`deriveSchema`); a
      // hand-written map would silently shadow them.
      if (module.filterSchemas !== undefined || "filterSchemas" in raw)
        throw new EntityDeclarationError(
          `${entry.name} exports filterSchemas; declare filters as descriptors with deriveSchema instead.`,
        );
      declarationModules.set(String(raw.key), {
        path: `../entity-definitions/${entry.name.replace(/\.ts$/, "")}`,
        enumExports: Object.keys(module).filter((key) =>
          key.startsWith("generated"),
        ),
      });
      return raw;
    }),
  );
  const entities = compileLoadedEntityDeclarations(loaded);
  validatePredicateBaseline(entities);
  return { entities, declarations: loaded };
};

export const loadEntityDeclarations = async (): Promise<CompiledEntity[]> =>
  (await loadEntityDeclarationBundle()).entities;

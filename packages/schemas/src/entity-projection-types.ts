import type { compileEnumOptions } from "@cubby/shared/enum-palette";
import type { Entity } from "./entity-core";
import type { RelationshipPathStep } from "./entity-integrity";
import type {
  CompiledEntityPresentation,
  EntityFieldKind,
  EntityFieldControlKind,
  EntityFieldModelMetadata,
} from "./entity-definitions/definition";

/** Declaration shapes remain schema-derived; only compiled presentation is projected below. */
type ReadonlyMetadata<T> = { readonly [K in keyof T]: ReadonlyMetadata<T[K]> };
type DeclaredField = ReadonlyMetadata<
  EntityFieldModelMetadata["fields"][number]
>;
type DeclaredControl = NonNullable<DeclaredField["control"]>;
type DeclaredOption = NonNullable<DeclaredControl["options"]>[number];
type CompiledFieldOption = ReturnType<
  typeof compileEnumOptions<DeclaredOption>
>[number];
// Built-in display projections may provide labels and color without a control glyph.
type DisplayFieldOption = Omit<DeclaredOption, "color"> & { color?: string };
type CompiledControl = Omit<DeclaredControl, "options"> & {
  options: readonly CompiledFieldOption[] | null;
};

export type GeneratedEntityFieldKind = EntityFieldKind;
export type GeneratedEntityFieldControlKind = EntityFieldControlKind;

type GeneratedEntityFieldResolutionValue =
  | string
  | number
  | boolean
  | null
  | readonly GeneratedEntityFieldResolutionValue[]
  | GeneratedEntityFieldResolutionObject;
interface GeneratedEntityFieldResolutionObject {
  readonly [key: string]: GeneratedEntityFieldResolutionValue;
}

export type GeneratedEntityFieldProvenance<E extends string = Entity> = {
  kind: "reference" | "relation" | "derived";
  sources: readonly {
    entity: E | null;
    label: string | null;
    relation: string | null;
  }[];
};

export type GeneratedEntityFieldModel<E extends string = Entity> = {
  fields: readonly {
    key: DeclaredField["key"];
    kind: DeclaredField["kind"];
    dateRange: DeclaredField["dateRange"];
    nullable: DeclaredField["nullable"];
    requiredOnCreate: boolean;
    label: string;
    description: DeclaredField["description"];
    readKey: string | null;
    storedKey: NonNullable<DeclaredField["storedKey"]> | null;
    /** Path inside the stored result; absent for a whole-value snapshot. */
    storedPath: readonly string[] | null;
    storedProjection?: true;
    reference: DeclaredField["reference"];
    explanation: DeclaredField["explanation"];
    resolution: {
      reset: Readonly<Record<string, GeneratedEntityFieldResolutionValue>>;
      none: Readonly<
        Record<string, GeneratedEntityFieldResolutionValue>
      > | null;
      redundancy: "eligible" | "intentional";
      confirm: Readonly<
        Record<string, GeneratedEntityFieldResolutionValue>
      > | null;
      labels: { none?: string; unresolved?: string } | null;
    } | null;
    provenance: GeneratedEntityFieldProvenance<E> | null;
    collection?: DeclaredField["collection"];
    control: CompiledControl | null;
    display: {
      list: boolean;
      detail: boolean;
      columnId: string | null;
      standard: "name" | "image" | null;
      detailOrder: number | null;
      listOrder: number | null;
      width: "xs" | "sm" | "md" | "lg" | "xl" | null;
      readPath: string | null;
      labelPath: string | null;
      emptyLabel?: string | null;
      detailLabelPath?: string | null;
      itemsPath?: string | null;
      format:
        | "currency"
        | "signedCurrency"
        | "plainDate"
        | "timestamp"
        | "external-link"
        | "amount"
        | "presence"
        | "bytes"
        | "join"
        | "arrayCount"
        | "count"
        | "resolvedList"
        | null;
      renderer: { list: string | null; detail: string | null } | null;
      mobile: { slot: string; priority: number; interactive?: boolean } | null;
      listHidden: boolean;
      referencePreviewLimit: number | null;
      columnLabel: string | null;
      columnGroup?: string;
      columnBar?: boolean;
      valueOptions: readonly DisplayFieldOption[] | null;
      preview: boolean;
    };
  }[];

  storage: readonly {
    key: string;
    column: string;
    kind: GeneratedEntityFieldKind;
    nullable: boolean;
    default: "none" | "generated" | "now" | "literal";
    defaultValue: unknown;
    reference: string | null;
    specialized: string | null;
  }[];

  create: readonly string[];

  update: readonly string[];

  bulk: readonly string[];

  audit: readonly string[];

  output: readonly string[];

  research?: { readonly fillFields: readonly string[] };
};

/**
 * A declared correlated aggregate over a relation path. `column` is the
 * terminal stored column a `sum`/`min`/`max` reads (null for `count`);
 * `absent` lists terminal columns that must be NULL.
 */
export type GeneratedRollup<E extends string = Entity> = {
  readonly aggregate: "count" | "sum" | "min" | "max";
  readonly path: string;
  readonly steps: readonly RelationshipPathStep[];
  readonly target: E;
  readonly column: string | null;
  readonly absent: readonly string[];
};

export type GeneratedListField<E extends string = Entity> =
  | {
      readonly shape: "via";
      readonly requiresResult?: string;
      readonly path: string;
      readonly steps: readonly RelationshipPathStep[];
      readonly target: E;
      readonly terminal:
        | { readonly kind: "record"; readonly titleColumn: string | null }
        | {
            readonly kind: "field";
            readonly column: string;
            readonly fieldKind: string;
          };
      readonly many: boolean;
      readonly sort: string | null;
      readonly group: string | null;
    }
  | {
      readonly shape: "rows";
      readonly requiresResult?: string;
      readonly path: string;
      readonly rows: string;
      readonly terminal:
        | {
            readonly kind: "column";
            readonly column: string;
            readonly fieldKind: string | null;
            readonly options: GroupOptions;
          }
        | {
            readonly kind: "record";
            readonly target: E;
            readonly titleColumn: string | null;
            readonly column: string | null;
          };
      readonly sort: string;
      readonly group: string;
    }
  | {
      readonly shape: "value";
      readonly type:
        | "text"
        | "number"
        | "date"
        | "dateInterval"
        | "boolean"
        | "enum";
      readonly options: readonly string[] | null;
      readonly sort: null;
      readonly group: string | null;
      /** Compiled from a `rollup` declaration; the repository passes no SQL. */
      readonly rollup?: GeneratedRollup<E>;
      readonly fromResult?: {
        readonly key: string;
        readonly path: readonly string[];
      };
      readonly requiresResult?: string;
    }
  | {
      readonly shape: "predicate";
      readonly predicate:
        | "text"
        | "multiselect"
        | "idMulti"
        | "boolean"
        | "presence"
        | "range";
      readonly options: readonly string[] | null;
      readonly reason: string;
      readonly requiresResult?: string;
      readonly sort: string;
      readonly group: string;
    };

export type GeneratedRowSet<E extends string = Entity> = {
  readonly label: string;
  readonly storage:
    | {
        readonly kind: "path";
        readonly steps: readonly RelationshipPathStep[];
        readonly where: Readonly<Record<string, string>>;
      }
    | {
        readonly kind: "json";
        readonly column: string;
        readonly keys: readonly string[];
      }
    | {
        readonly kind: "relation";
        readonly steps: readonly RelationshipPathStep[];
        readonly target: E;
      }
    | {
        readonly kind: "repository";
        readonly columns: Readonly<Record<string, E | null>>;
        readonly connections: readonly string[];
        readonly types: Readonly<Record<string, string>>;
      };
};

type InheritHop<E extends string = Entity> = {
  readonly field: string;
  readonly column: string;
  readonly target: E;
};

export type GeneratedInherit<E extends string = Entity> = {
  readonly column: string;
  readonly reference: E | null;
  readonly empty: "array" | null;
  readonly mode: {
    readonly column: string;
    readonly inherit: string;
    readonly none: readonly string[];
    readonly explicitIfSet: boolean;
  } | null;
  readonly from: readonly (
    | {
        readonly kind: "hierarchy";
        readonly parentColumn: string;
        readonly maxDepth: number;
        readonly whileSame: {
          readonly field: string;
          readonly column: string;
        } | null;
      }
    | {
        readonly kind: "effective";
        readonly when?: {
          readonly column: string;
          readonly value: string;
        } | null;
        readonly hops: readonly InheritHop<E>[];
        readonly field: string;
        readonly column: string;
      }
  )[];
};

type GroupOptions =
  | readonly { readonly value: string; readonly label: string }[]
  | null;

export type GeneratedGroupChoice<E extends string = Entity> = {
  readonly key: string;
  readonly label: string;
  readonly noValueLabel: string;
  readonly reason: string | null;
  readonly value:
    | {
        readonly kind: "column";
        readonly column: string;
        readonly options: GroupOptions;
      }
    | {
        readonly kind: "record";
        readonly steps: readonly RelationshipPathStep[];
        readonly target: E;
        readonly titleColumn: string;
      }
    | {
        readonly kind: "field";
        readonly steps: readonly RelationshipPathStep[];
        readonly target: E;
        readonly column: string;
        readonly options: GroupOptions;
      }
    | { readonly kind: "derived"; readonly options: GroupOptions }
    | null;
  readonly filter: {
    readonly columnId: string;
    readonly noValue: boolean;
    readonly subtree: string | null;
  } | null;
  readonly levels: number;
  readonly levelReason: string | null;
  readonly multiple: boolean;
  readonly dateKind: "date" | "timestamp" | null;
  readonly buckets: readonly ("day" | "week" | "month" | "quarter" | "year")[];
};

export type GeneratedListScope<E extends string = Entity> = {
  readonly filters: E;
  readonly via: Extract<GeneratedListField<E>, { shape: "via" | "rows" }>;
};

export type EntityInspectorMetadata = CompiledEntityPresentation & {
  singular: string;

  plural: string | null;

  shortcodePrefix: string | null;

  searchable: boolean;

  primarySearch: { key: string; placeholder: string } | null;

  browserRouted: boolean;

  auditable: boolean;

  hasImages: boolean;

  imageStorage: false | "gallery" | "cover" | "logo";

  displayImages: boolean;

  countable: boolean;

  kernelActions: readonly (
    | "get"
    | "list"
    | "search"
    | "create"
    | "update"
    | "bulkUpdate"
    | "delete"
    | "merge"
    | "resolve"
  )[];

  filterUrlKeys: readonly string[];

  filterDescriptors: readonly EntityFilterDescriptorMetadata[];

  mcpOperations: readonly (
    | "get"
    | "list"
    | "search"
    | "create"
    | "update"
    | "delete"
    | "bulkUpdate"
    | "merge"
  )[];

  mcpOwner: "kernel" | "workflow" | null;

  lifecycle: {
    softDelete: boolean;
    delete: { mode: "soft" | "hard"; bulk: boolean } | null;
    merge: boolean;
    bulkUpdate: { fields: readonly string[] } | null;
  };

  operationOwners: {
    delete: "kernel" | "workflow" | null;
    merge: "kernel" | "workflow" | null;
  };

  sourceRefs: {
    create?: string;
    update?: string;
    output: string;
    list: string;
    detail: string;
    mcpOutput: string;
    mcpList: string;
    mcpDetail: string;
  } | null;

  ports: EntityPortSourceRoster;

  references: readonly Entity[];
};

type EntityPortSourceRef = { module: string; export: string };

type EntityInspectorOptionValue =
  | string
  | number
  | boolean
  | null
  | Readonly<{ phosphor: string; sfSymbol: string }>;

type EntityInspectorOption = Readonly<
  Record<string, EntityInspectorOptionValue>
>;

type EntityFilterDescriptorMetadata = {
  columnId: string;
  field: string | null;
  urlKey: string;
  kind: string;
  placeholder: string;

  options: readonly EntityInspectorOption[] | null;
  optionsRef: EntityPortSourceRef | null;
  optionsKey: string | null;

  label: string | null;
  schemaDescription: string | null;
  deriveSchema: boolean;
  schemaFromRead: boolean;
  brandRef: { entity: string } | null;
  expandRef: EntityPortSourceRef | null;
  schemaRef: EntityPortSourceRef | null;
  stored: { columns: readonly string[]; array: boolean } | null;
  anyOf: readonly { key: string; source: "field" | "derived" }[] | null;
  derived: string | null;
  range: {
    kind: "number" | "date";
    int: boolean;
    nonnegative: boolean;
    finite: boolean;
    describe: { lower: string; upper: string } | null;
  } | null;

  nullable: { field: string; label: string } | null;
  match: { field: string } | null;
  exclude: { field: string } | null;
  subtree: string | null;
  currentMember: boolean;
  singleValue: string | null;
  exclusiveGroup: string | null;
  aliasOf: string | null;
  sentinels: readonly { value: string; label: string }[] | null;

  wire:
    | { kind: "param"; name: string }
    | { kind: "range"; from: string; to: string; presence?: string };
};

type EntityPortSourceRoster = {
  repository: EntityPortSourceRef | null;
  fieldEnvelope: EntityPortSourceRef | null;

  references: {
    label: EntityPortSourceRef | null;
    resolver: EntityPortSourceRef | null;
  };

  filters: EntityPortSourceRef | null;

  search: {
    projection: EntityPortSourceRef | null;
    semanticText: EntityPortSourceRef | null;
  };

  timeline: EntityPortSourceRef | null;
};

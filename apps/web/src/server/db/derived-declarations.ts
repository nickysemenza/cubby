/**
 * Every stored derived value (ADR 0021), read once from the entity manifest
 * (`model.derived.<key>.stored`), plus the internal records this module
 * registers. The drain and the generated triggers resolve every declaration
 * here, so a value has one declaration and no parallel scheduling list. List
 * reads, explanations and other entity metadata read only the entity subset.
 */
import { entitySchema, type Entity } from "@cubby/schemas/entity";
import { storedDerivedManifest } from "@cubby/schemas/entity-stored-derived";
import { z } from "zod";

const snapshotSource = z.object({
  table: z.string(),
  value: z.union([z.string(), z.record(z.string(), z.string())]),
  computedAt: z.string(),
  decidedBy: z.string().optional(),
  sort: z.string().optional(),
  storage: z.enum(["json", "number", "text"]).optional(),
  view: z.boolean().optional(),
});

/** One input: changes to `table` rows whose `tableColumn` equals the value's `entityColumn`. */
export interface DerivedInput {
  readonly table: string;
  readonly tableColumn: string;
  readonly entityColumn: string;
  /**
   * `textHash`: refs are the hash of a non-UUID `tableColumn` from
   * `textHashRefSqlText`, reaching targets only through `selection` or `path`.
   * Absent: the column value is the UUID ref. Internal records only.
   */
  readonly captureKey?: "textHash";
  /** False suppresses source triggers, never pending fanout interpretation. */
  readonly capture?: false;
  /** Columns whose change matters; null = any column except `updatedAt`. */
  readonly columns: readonly string[] | null;
  /** Only rows holding these column values count. */
  readonly where: Readonly<Record<string, string>> | null;
  /** Without `columns`: columns besides `updatedAt` whose change never matters. */
  readonly except: readonly string[];
  /** A join path from the matched value to this entity's ids. */
  readonly path: readonly DerivedPathStep[] | null;
  readonly paths?: readonly (readonly DerivedPathStep[])[];
  readonly targetWhere: Readonly<Record<string, string | null>> | null;
  readonly selection?: {
    readonly key: string;
    readonly path?: readonly DerivedPathStep[];
    /** Entity values only: prior refs in the `DerivedValue`. An internal record's callback returns its own. */
    readonly retained?: {
      readonly array: readonly string[];
      readonly key: string;
    };
  };
  /** The matched column is JSON; values are `key` of the array at `array`. */
  readonly json: {
    readonly array?: readonly string[];
    readonly key: string;
  } | null;
}

/** One join step: `to` of `table` rows whose `from` holds a previous value. */
export interface DerivedPathStep {
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly jsonKey?: string;
  readonly fromJsonKey?: string;
  readonly where?: Readonly<Record<string, string>>;
  readonly recursive?: { readonly maxDepth: number };
}

/**
 * Another stored value this one reads: joined `source.sourceColumn =
 * this.entityColumn`, or through a link table whose `source` column holds the
 * changed record and `dependent` column the record to mark.
 */
export type DerivedDependency = {
  readonly entity: Entity;
  readonly key: string;
} & (
  | { readonly sourceColumn: string; readonly entityColumn: string }
  | { readonly path: readonly DerivedPathStep[] }
  | { readonly targetWhere: Readonly<Record<string, string | null>> }
  | {
      readonly through: {
        readonly table: string;
        readonly source: string;
        readonly dependent: string;
        readonly where: Readonly<Record<string, string>> | null;
      };
    }
);

type DerivedSortType = "number" | "date" | "text" | null;

/** What the drain and triggers need, whichever owner the target belongs to. */
interface StoredDerivedWork {
  /** The dirty-row target: a stable name pending tickets keep across deploys. */
  readonly target: string;
  /** The source table: its UUID `id` is the mark's ref and sink lock. */
  readonly table: string;
  readonly compute: string;
  readonly inputs: readonly DerivedInput[];
  readonly dependsOn: readonly DerivedDependency[];
}

export interface EntityStoredDerivedDeclaration extends StoredDerivedWork {
  readonly kind: "entity";
  readonly entity: Entity;
  readonly key: string;
  /** Publication and freshness ring this declaration's own record refs. */
  readonly notifications: "entityRefs";
  readonly clock: "householdDay" | null;
  readonly rebuildPhase?: "facts" | "quality" | "search" | "diagnostics";
  /**
   * `derivedValue`: published as a `DerivedValue` row, with per-row meta in the
   * envelope. `ownTable`: written to the value's own table (search documents,
   * recipe totals), so readers read that table.
   */
  readonly publishes: "derivedValue" | "ownTable";
  readonly snapshotSource?: z.infer<typeof snapshotSource>;
  readonly recordSource: {
    readonly value: string;
    readonly computedAt: string;
    readonly freshAt?: string;
  } | null;
  readonly sort: DerivedSortType;
}

/**
 * A publication about non-entity records: no public Entity, DerivedValue
 * envelope, field metadata or explanation. It must use a `derivedSink`, whose
 * refs are `table` ids rather than entity ids, so the sink names the entities
 * each publication affected through its publication context. Marks and fanout
 * expansion ring nothing. Dependencies may read entity values; no stored value
 * can depend on an internal record.
 */
interface InternalStoredDerivedDeclaration extends StoredDerivedWork {
  readonly kind: "internalRecord";
  readonly label: string;
  readonly publishes: "ownTable";
  readonly notifications: "sinkOwned";
  /** Rows the daily pass marks, sharing `table`'s UUID `id`; null marks every row. */
  readonly reconcile: {
    readonly table: string;
    readonly where: Readonly<Record<string, string | null | readonly string[]>>;
  } | null;
}

export type StoredDerivedDeclaration =
  | EntityStoredDerivedDeclaration
  | InternalStoredDerivedDeclaration;

const pathStep = z.object({
  table: z.string(),
  from: z.string(),
  to: z.string(),
  jsonKey: z.string().optional(),
  fromJsonKey: z.string().optional(),
  where: z.record(z.string(), z.string()).optional(),
  recursive: z.object({ maxDepth: z.number().int().positive() }).optional(),
});

const storedInput = z.object({
  table: z.string(),
  match: z.record(z.string(), z.string()),
  capture: z.literal(false).optional(),
  columns: z.array(z.string()).optional(),
  where: z.record(z.string(), z.string()).optional(),
  except: z.array(z.string()).optional(),
  path: z.array(pathStep).optional(),
  paths: z.array(z.array(pathStep).min(1)).min(1).optional(),
  targetWhere: z.record(z.string(), z.string().nullable()).optional(),
  selection: z
    .object({
      key: z.string(),
      path: z.array(pathStep).optional(),
      retained: z.object({
        array: z.array(z.string()).min(1),
        key: z.string(),
      }),
    })
    .optional(),
  json: z
    .object({ array: z.array(z.string()).optional(), key: z.string() })
    .optional(),
});

const storedDependency = z.union([
  z.object({
    entity: entitySchema,
    key: z.string(),
    targetWhere: z
      .record(z.string(), z.string().nullable())
      .refine((where) => Object.keys(where).length > 0),
  }),
  z.object({
    entity: entitySchema,
    key: z.string(),
    match: z.record(z.string(), z.string()),
  }),
  z.object({
    entity: entitySchema,
    key: z.string(),
    path: z.array(pathStep),
  }),
  z.object({
    entity: entitySchema,
    key: z.string(),
    through: z.object({
      table: z.string(),
      source: z.string(),
      dependent: z.string(),
      where: z.record(z.string(), z.string()).optional(),
    }),
  }),
]);

/** The generated registry's entry, parsed at this boundary. */
const storedEntry = z.object({
  entity: entitySchema,
  key: z.string(),
  table: z.string().nullable(),
  type: z.string(),
  publishes: z.enum(["derivedValue", "ownTable"]),
  stored: z.object({
    compute: z.string(),
    rebuildPhase: z
      .enum(["facts", "quality", "search", "diagnostics"])
      .optional(),
    snapshotSource: snapshotSource.optional(),
    recordSource: z
      .object({
        value: z.string(),
        computedAt: z.string(),
        freshAt: z.string().optional(),
      })
      .optional(),
    clock: z.literal("householdDay").optional(),
    inputs: z.array(storedInput),
    dependsOn: z.array(storedDependency).optional(),
  }),
});

/**
 * An internal record's input: the manifest shape, except `selection` has no
 * `retained` `DerivedValue` to read, so its callback returns current and retained
 * dependents alike, and a non-UUID source column can capture through `captureKey`.
 * These authoring mistakes would otherwise expand to the wrong records silently.
 */
const internalInput = storedInput
  .omit({ selection: true })
  .extend({
    selection: z
      .strictObject({
        key: z.string(),
        path: z.array(pathStep).optional(),
      })
      .optional(),
    captureKey: z.literal("textHash").optional(),
  })
  .refine(
    (input) =>
      !input.selection || (!input.path && !input.paths && !input.targetWhere),
    "selection replaces path, paths and targetWhere; map sources with selection.path",
  )
  .refine(
    (input) => !input.captureKey || (!input.json && !input.targetWhere),
    "captureKey hashes one plain column, so it cannot be combined with json or targetWhere",
  )
  .refine(
    (input) =>
      !input.captureKey || input.selection || input.path || input.paths,
    "A captureKey hash is not a target id; reach targets through selection, path or paths",
  )
  .refine(
    (input) =>
      (!input.selection && !input.captureKey) ||
      Object.values(input.match).every((column) => column === "id"),
    "selection and captureKey expansion ignore the target column; match it to id",
  );

/**
 * One internal record publication. `target` is `<owner>.<key>`, where the owner
 * is not an entity, so it cannot shadow a manifest target. Dependencies are the
 * same authoring shapes a manifest declares. `reconcile` narrows the daily pass
 * to rows that can still be owed, for a source table with a closed history.
 */
const internalRecordSpec = z.object({
  label: z.string().min(1),
  target: z
    .string()
    .regex(/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/)
    .refine((target) => !entitySchema.safeParse(target.split(".")[0]).success),
  table: z.string(),
  compute: z.string(),
  notifications: z.literal("sinkOwned"),
  inputs: z.array(internalInput),
  dependsOn: z.array(storedDependency).optional(),
  reconcile: z
    .object({
      table: z.string(),
      where: z
        .record(
          z.string(),
          z.union([z.string(), z.null(), z.array(z.string()).min(1)]),
        )
        .refine((where) => Object.keys(where).length > 0),
    })
    .optional(),
});

type InternalRecordSpec = z.input<typeof internalRecordSpec>;

/**
 * Registered internal records. Append only: triggers and the drain read this
 * list after the manifest, and pending fanouts name an input by position, so
 * an entry's inputs also keep their order.
 */
const internalRecordSpecs: readonly InternalRecordSpec[] = [];

const onePair = (match: Record<string, string>): [string, string] => {
  const entries = Object.entries(match);
  const [pair] = entries;
  if (entries.length !== 1 || !pair)
    throw new Error("A derived match pairs exactly one column");
  return pair;
};

const sortTypeOf = (type: string | undefined): DerivedSortType =>
  type === "number"
    ? "number"
    : type === "date"
      ? "date"
      : type
        ? "text"
        : null;

const declaredInput = (
  input: z.output<typeof storedInput> | z.output<typeof internalInput>,
): DerivedInput => {
  const [tableColumn, entityColumn] = onePair(input.match);
  return {
    table: input.table,
    tableColumn,
    entityColumn,
    ...("captureKey" in input && input.captureKey
      ? { captureKey: input.captureKey }
      : {}),
    ...(input.capture === false ? { capture: false as const } : {}),
    columns: input.columns ?? null,
    where: input.where ?? null,
    except: input.except ?? [],
    path: input.path ?? null,
    ...(input.paths ? { paths: input.paths } : {}),
    targetWhere: input.targetWhere ?? null,
    ...(input.selection ? { selection: input.selection } : {}),
    json: input.json ?? null,
  };
};

const declaredDependency = (
  dependency: z.output<typeof storedDependency>,
): DerivedDependency => {
  if ("targetWhere" in dependency)
    return {
      entity: dependency.entity,
      key: dependency.key,
      targetWhere: dependency.targetWhere,
    };
  if ("path" in dependency)
    return {
      entity: dependency.entity,
      key: dependency.key,
      path: dependency.path,
    };
  if ("through" in dependency)
    return {
      entity: dependency.entity,
      key: dependency.key,
      through: {
        ...dependency.through,
        where: dependency.through.where ?? null,
      },
    };
  const [sourceColumn, entityColumn] = onePair(dependency.match);
  return {
    entity: dependency.entity,
    key: dependency.key,
    sourceColumn,
    entityColumn,
  };
};

const manifestDeclarations = (): EntityStoredDerivedDeclaration[] =>
  z
    .array(storedEntry)
    .parse(storedDerivedManifest)
    .flatMap((entry) => {
      if (!entry.table) return [];
      return [
        {
          kind: "entity",
          entity: entry.entity,
          key: entry.key,
          notifications: "entityRefs",
          target: `${entry.entity}.${entry.key}`,
          table: entry.table,
          compute: entry.stored.compute,
          clock: entry.stored.clock ?? null,
          rebuildPhase: entry.stored.rebuildPhase ?? "facts",
          publishes: entry.publishes,
          recordSource: entry.stored.recordSource ?? null,
          snapshotSource: entry.stored.snapshotSource,
          sort: sortTypeOf(entry.type),
          inputs: entry.stored.inputs.map(declaredInput),
          dependsOn: (entry.stored.dependsOn ?? []).map(declaredDependency),
        } satisfies EntityStoredDerivedDeclaration,
      ];
    });

const internalRecordDeclarations = (): InternalStoredDerivedDeclaration[] => {
  const specs = z.array(internalRecordSpec).parse(internalRecordSpecs);
  const targets = specs.map((spec) => spec.target);
  if (new Set(targets).size !== targets.length)
    throw new Error("Internal derived record targets must be unique");
  return specs.map((spec): InternalStoredDerivedDeclaration => ({
    kind: "internalRecord",
    label: spec.label,
    publishes: "ownTable",
    notifications: spec.notifications,
    reconcile: spec.reconcile ?? null,
    target: spec.target,
    table: spec.table,
    compute: spec.compute,
    inputs: spec.inputs.map(declaredInput),
    dependsOn: (spec.dependsOn ?? []).map(declaredDependency),
  }));
};

let cached: readonly StoredDerivedDeclaration[] | null = null;

export function storedDerivedDeclarations(): readonly StoredDerivedDeclaration[] {
  cached ??= [...manifestDeclarations(), ...internalRecordDeclarations()];
  return cached;
}

/** The public metadata roster: internal records never appear in entity reads. */
export function entityStoredDerivedDeclarations(): readonly EntityStoredDerivedDeclaration[] {
  return storedDerivedDeclarations().filter(
    (entry): entry is EntityStoredDerivedDeclaration => entry.kind === "entity",
  );
}

export function storedDerived(
  entity: Entity,
  key: string,
): EntityStoredDerivedDeclaration | null {
  return (
    entityStoredDerivedDeclarations().find(
      (entry) => entry.entity === entity && entry.key === key,
    ) ?? null
  );
}

function storedDerivedByTarget(
  target: string,
): StoredDerivedDeclaration | null {
  return (
    storedDerivedDeclarations().find((entry) => entry.target === target) ?? null
  );
}

/** Whether a changed input row marks records directly or through the drain. */
export const isFanoutInput = (input: DerivedInput) =>
  input.entityColumn !== "id" ||
  input.selection !== undefined ||
  input.path !== null ||
  input.paths !== undefined ||
  input.json !== null ||
  input.targetWhere !== null;

/** A fanout mark names its input: `<entity>.<key>@<input index>`. */
export const fanoutTarget = (target: string, inputIndex: number) =>
  `${target}@${inputIndex}`;

export function parseTarget(target: string): {
  declaration: StoredDerivedDeclaration;
  fanoutInput: DerivedInput | null;
} | null {
  const [base, index] = target.split("@");
  const declaration = base ? storedDerivedByTarget(base) : null;
  if (!declaration) return null;
  if (index === undefined) return { declaration, fanoutInput: null };
  const input = declaration.inputs[Number(index)];
  // A retired input's pending fanout has nothing left to expand.
  return input && isFanoutInput(input)
    ? { declaration, fanoutInput: input }
    : null;
}

/** Declarations that read `entity.key`, for propagation after it changes. */
export function dependentsOf(
  entity: Entity,
  key: string,
): readonly {
  declaration: StoredDerivedDeclaration;
  dependency: DerivedDependency;
}[] {
  return storedDerivedDeclarations().flatMap((declaration) =>
    declaration.dependsOn
      .filter(
        (dependency) => dependency.entity === entity && dependency.key === key,
      )
      .map((dependency) => ({ declaration, dependency })),
  );
}

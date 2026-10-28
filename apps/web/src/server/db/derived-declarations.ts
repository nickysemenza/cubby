/**
 * Every stored derived value (ADR 0021), read once from the entity manifest
 * (`model.derived.<key>.stored`). The drain,
 * the generated triggers, list reads and explanations all resolve declarations
 * here, so a value has one declaration and no parallel scheduling list.
 */
import { entitySchema, type Entity } from "@cubby/schemas/entity";
import { storedDerivedManifest } from "@cubby/schemas/entity-stored-derived";
import { z } from "zod";

/** One input: changes to `table` rows whose `tableColumn` equals the value's `entityColumn`. */
export interface DerivedInput {
  readonly table: string;
  readonly tableColumn: string;
  readonly entityColumn: string;
  /** Columns whose change matters; null = any column except `updatedAt`. */
  readonly columns: readonly string[] | null;
  /** Only rows holding these column values count. */
  readonly where: Readonly<Record<string, string>> | null;
  /** Without `columns`: columns besides `updatedAt` whose change never matters. */
  readonly except: readonly string[];
  /** A join path from the matched value to this entity's ids. */
  readonly path: readonly DerivedPathStep[] | null;
  readonly targetWhere: Readonly<Record<string, string | null>> | null;
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

export interface StoredDerivedDeclaration {
  readonly entity: Entity;
  readonly key: string;
  /** `<entity>.<key>`, the dirty-row target and explanation identifier. */
  readonly target: string;
  readonly table: string;
  readonly compute: string;
  readonly clock: "householdDay" | null;
  /**
   * `derivedValue`: published as a `DerivedValue` row, with per-row meta in the
   * envelope. `ownTable`: written to the value's own table (search documents,
   * recipe totals), so readers read that table.
   */
  readonly publishes: "derivedValue" | "ownTable";
  readonly recordSource: {
    readonly value: string;
    readonly computedAt: string;
    readonly freshAt?: string;
  } | null;
  readonly sort: DerivedSortType;
  readonly inputs: readonly DerivedInput[];
  readonly dependsOn: readonly DerivedDependency[];
}

const pathStep = z.object({
  table: z.string(),
  from: z.string(),
  to: z.string(),
  jsonKey: z.string().optional(),
  fromJsonKey: z.string().optional(),
  where: z.record(z.string(), z.string()).optional(),
});

/** The generated registry's entry, parsed at this boundary. */
const storedEntry = z.object({
  entity: entitySchema,
  key: z.string(),
  table: z.string().nullable(),
  type: z.string(),
  publishes: z.enum(["derivedValue", "ownTable"]),
  stored: z.object({
    compute: z.string(),
    recordSource: z
      .object({
        value: z.string(),
        computedAt: z.string(),
        freshAt: z.string().optional(),
      })
      .optional(),
    clock: z.literal("householdDay").optional(),
    inputs: z.array(
      z.object({
        table: z.string(),
        match: z.record(z.string(), z.string()),
        columns: z.array(z.string()).optional(),
        where: z.record(z.string(), z.string()).optional(),
        except: z.array(z.string()).optional(),
        path: z.array(pathStep).optional(),
        targetWhere: z.record(z.string(), z.string().nullable()).optional(),
        json: z
          .object({ array: z.array(z.string()).optional(), key: z.string() })
          .optional(),
      }),
    ),
    dependsOn: z
      .array(
        z.union([
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
        ]),
      )
      .optional(),
  }),
});

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

const manifestDeclarations = (): StoredDerivedDeclaration[] =>
  z
    .array(storedEntry)
    .parse(storedDerivedManifest)
    .flatMap((entry) => {
      if (!entry.table) return [];
      return [
        {
          entity: entry.entity,
          key: entry.key,
          target: `${entry.entity}.${entry.key}`,
          table: entry.table,
          compute: entry.stored.compute,
          clock: entry.stored.clock ?? null,
          publishes: entry.publishes,
          recordSource: entry.stored.recordSource ?? null,
          sort: sortTypeOf(entry.type),
          inputs: entry.stored.inputs.map((input) => {
            const [tableColumn, entityColumn] = onePair(input.match);
            return {
              table: input.table,
              tableColumn,
              entityColumn,
              columns: input.columns ?? null,
              where: input.where ?? null,
              except: input.except ?? [],
              path: input.path ?? null,
              targetWhere: input.targetWhere ?? null,
              json: input.json ?? null,
            };
          }),
          dependsOn: (entry.stored.dependsOn ?? []).map(
            (dependency): DerivedDependency => {
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
            },
          ),
        } satisfies StoredDerivedDeclaration,
      ];
    });

let cached: readonly StoredDerivedDeclaration[] | null = null;

export function storedDerivedDeclarations(): readonly StoredDerivedDeclaration[] {
  cached ??= manifestDeclarations();
  return cached;
}

export function storedDerived(
  entity: Entity,
  key: string,
): StoredDerivedDeclaration | null {
  return (
    storedDerivedDeclarations().find(
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
  input.path !== null ||
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

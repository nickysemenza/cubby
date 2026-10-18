import type { Entity } from "@cubby/schemas/entity";
import type { RelationshipPathStep } from "@cubby/schemas/entity-integrity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { is, type SQL, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import {
  effectiveFieldSql,
  inheritedFieldOfColumn,
} from "~/server/db/computed/effective-field";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import * as schema from "~/server/db/schema";
import { expenseDerivedReadSql } from "~/server/domains/expense/repo/expense-derived-read";
import { effectiveExpenseProjectSql } from "~/server/domains/expense/repo/expense-inheritance";

interface EdgeSpec {
  edgeKey: string;
  sourceTable: string;
  sourceColumn: string;
  /**
   * One table for an ordinary FK. `EntityAttachment.entityId` names any
   * attachable entity, so it lists each; entity ids are unique across tables,
   * which keeps the join exact without a kind filter.
   */
  targetTables: readonly string[];
  sourceSoftDeletable: boolean;
  /** `EntityLink` edges match only their own link kind's rows. */
  scope?: { column: string; value: string };
}

interface TraversalHop {
  table: string;
  relation?: string;
  alias: string;
  fromAlias: string;
  fromColumn: string;
  toColumn: string;
  softDelete: boolean;
  condition: SQL;
}

/** A statement-local relation of one table's rows with an inherited field's
 * effective value, joined in place of the table by an incoming inherited hop. */
export interface InheritedRelation {
  name: string;
  entity: Entity;
  field: string;
  table: string;
}

export interface Traversal {
  rootTable: string;
  rootAlias: string;
  hops: readonly TraversalHop[];
  leafTable: string;
  leafAlias: string;
  joins: SQL;
  usesExpenseProjectRelation: boolean;
  inheritedRelations: readonly InheritedRelation[];
}

/** The CTE body for an `InheritedRelation`: every row plus `"effectiveValue"`,
 * from the same expression the scalar join condition evaluates. */
export const inheritedRelationSql = (relation: InheritedRelation): SQL =>
  sql`${sql.identifier(relation.name)} AS MATERIALIZED (
    SELECT inherited_source.*, ${effectiveFieldSql(relation.entity, relation.field, "inherited_source")} AS "effectiveValue"
    FROM ${sql.identifier(relation.table)} inherited_source
  )`;

const entityTable = (entity: Entity): string => {
  const table = entityManifest[entity].dbTable;
  if (!table)
    throw new Error(`Relatedness cannot traverse external entity ${entity}`);
  return table;
};

/**
 * Build the canonical entity edges first, then add FK facts for owned
 * intermediate tables such as RecipeSection. Those rows are intentionally not
 * entities and therefore cannot appear as targets in INCOMING_EDGES, but a
 * manifest path may legitimately pass through them.
 */
const edgeIndex = (): ReadonlyMap<string, EdgeSpec> => {
  const specs = new Map<string, EdgeSpec>();
  for (const target of allEntities) {
    const edges = INCOMING_EDGES[target];
    for (const [edgeKey, edge] of Object.entries(edges)) {
      const column = edge.column;
      if (!is(column.table, PgTable)) {
        throw new Error(
          `Relatedness edge ${edgeKey} is not attached to a PgTable`,
        );
      }
      const config = getTableConfig(column.table);
      const known = specs.get(edgeKey);
      specs.set(edgeKey, {
        edgeKey,
        sourceTable: config.name,
        sourceColumn: column.name,
        targetTables: [...(known?.targetTables ?? []), entityTable(target)],
        sourceSoftDeletable: config.columns.some(
          (candidate) => candidate.name === "deletedAt",
        ),
        scope: edge.scope
          ? { column: edge.scope.column.name, value: edge.scope.value }
          : undefined,
      });
    }
  }
  type SchemaExport = (typeof schema)[keyof typeof schema];
  type SchemaTable = Extract<SchemaExport, PgTable>;
  const isSchemaTable = (value: SchemaExport): value is SchemaTable =>
    is(value, PgTable);
  for (const table of Object.values(schema).filter(isSchemaTable)) {
    const config = getTableConfig(table);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const targetTable = getTableConfig(reference.foreignTable).name;
      for (const column of reference.columns) {
        const edgeKey = `${config.name}.${column.name}`;
        if (specs.has(edgeKey)) continue;
        specs.set(edgeKey, {
          edgeKey,
          sourceTable: config.name,
          sourceColumn: column.name,
          targetTables: [targetTable],
          sourceSoftDeletable: config.columns.some(
            (candidate) => candidate.name === "deletedAt",
          ),
        });
      }
    }
  }
  return specs;
};

const EDGES = edgeIndex();

/**
 * One schema table's column names and its foreign-key columns by the table
 * they reference: what a row set's `where` and terminal resolve against.
 */
interface TableFacts {
  readonly columns: ReadonlySet<string>;
  readonly references: ReadonlyMap<string, readonly string[]>;
}

const TABLES: ReadonlyMap<string, TableFacts> = new Map(
  Object.values(schema)
    .filter((value): value is Extract<typeof value, PgTable> =>
      is(value, PgTable),
    )
    .map((table) => {
      const config = getTableConfig(table);
      const references = new Map<string, string[]>();
      for (const foreignKey of config.foreignKeys) {
        const reference = foreignKey.reference();
        const target = getTableConfig(reference.foreignTable).name;
        references.set(target, [
          ...(references.get(target) ?? []),
          ...reference.columns.map((column) => column.name),
        ]);
      }
      return [
        config.name,
        {
          columns: new Set(config.columns.map((column) => column.name)),
          references,
        },
      ];
    }),
);

export const tableFacts = (name: string): TableFacts => {
  const facts = TABLES.get(name);
  if (facts === undefined) throw new Error(`No schema table ${name}`);
  return facts;
};

/** The one foreign-key column of `table` that references `target`'s table. */
export const referenceColumn = (table: string, target: Entity): string => {
  const [column, ...others] =
    tableFacts(table).references.get(entityTable(target)) ?? [];
  if (column === undefined || others.length > 0)
    throw new Error(
      `${table} needs exactly one foreign key to ${target}, found ${[column, ...others].filter(Boolean).join(", ") || "none"}`,
    );
  return column;
};

const softDeleteForTable = (tableName: string): boolean => {
  const entity = allEntities.find(
    (candidate) => entityManifest[candidate].dbTable === tableName,
  );
  return entity === undefined ? false : entityManifest[entity].softDelete;
};

export const invertPath = (
  steps: readonly RelationshipPathStep[],
): readonly RelationshipPathStep[] =>
  steps
    .slice()
    .reverse()
    .map((step) => ({
      ...step,
      direction: step.direction === "incoming" ? "outgoing" : "incoming",
    }));

/** The inherited field an edge's foreign key stores, if any. */
const inheritedEdge = (
  edge: EdgeSpec,
): { entity: Entity; field: string } | null => {
  const entity = allEntities.find(
    (candidate) => entityManifest[candidate].dbTable === edge.sourceTable,
  );
  const field =
    entity === undefined
      ? null
      : inheritedFieldOfColumn(entity, edge.sourceColumn);
  return entity === undefined || field === null ? null : { entity, field };
};

/**
 * Relationship discovery follows effective values: an inherited reference
 * (`resolution.inherit`) joins on its effective value, and shared charges on
 * their allocations.
 */
function edgeCondition(
  edge: EdgeSpec,
  sourceAlias: string,
  targetAlias: string,
  productScopedExpense: boolean,
): SQL {
  const target = sql.raw(`${targetAlias}."id"`);
  const inherited = inheritedEdge(edge);
  if (inherited !== null)
    return sql`${effectiveFieldSql(inherited.entity, inherited.field, sourceAlias)} = ${target}`;
  // The database requires a product-linked Expense to be principal. For a
  // product-scoped path, allocation is therefore the scalar effective project.
  if (edge.edgeKey === "Expense.projectId" && productScopedExpense)
    return sql`${effectiveExpenseProjectSql(
      sourceAlias,
      sql`${sql.raw(`${targetAlias}."shortcode"`)} = 'PRJ-HSHD'`,
    )} = ${target}`;
  if (edge.edgeKey === "Expense.projectId")
    return sql`(${sql.raw(`${sourceAlias}."id"`)}, ${target}) IN (
      SELECT attributed."expenseId", attributed."projectId"
      FROM (${expenseDerivedReadSql("projects")}) attributed
    )`;
  const matches = sql`${sql.raw(`${sourceAlias}."${edge.sourceColumn}"`)} = ${target}`;
  return edge.scope
    ? sql`${matches} AND ${sql.raw(`${sourceAlias}."${edge.scope.column}"`)} = ${edge.scope.value}`
    : matches;
}

const outgoingTarget = (edge: EdgeSpec, to: Entity | undefined): string => {
  const [only, ...others] = edge.targetTables;
  if (only !== undefined && others.length === 0) return only;
  const table = to === undefined ? undefined : entityTable(to);
  if (table === undefined || !edge.targetTables.includes(table)) {
    throw new Error(
      `Path ${edge.edgeKey} (outgoing) targets ${edge.targetTables.join(" | ")}; name the destination as the final step.`,
    );
  }
  return table;
};

const productScopedExpenseAt = (
  steps: readonly RelationshipPathStep[],
  index: number,
): boolean =>
  steps[index]?.edge === "Expense.projectId" &&
  (steps[index - 1]?.edge === "Expense.productId" ||
    steps[index + 1]?.edge === "Expense.productId");

const mappedExpenseProjectAt = (
  edge: EdgeSpec,
  outgoing: boolean,
  steps: readonly RelationshipPathStep[],
  index: number,
  relation: string | undefined,
): boolean =>
  !outgoing &&
  edge.edgeKey === "Expense.projectId" &&
  productScopedExpenseAt(steps, index) &&
  relation !== undefined;

const traversalEdgeCondition = (
  edge: EdgeSpec,
  alias: string,
  currentAlias: string,
  outgoing: boolean,
  productScopedExpense: boolean,
  mappedExpenseProject: boolean,
): SQL =>
  mappedExpenseProject
    ? sql`${sql.raw(`${alias}."effectiveProjectId"`)} = ${sql.raw(`${currentAlias}."id"`)}`
    : edgeCondition(
        edge,
        outgoing ? currentAlias : alias,
        outgoing ? alias : currentAlias,
        productScopedExpense,
      );

/**
 * Compile a manifest-only path into structural joins. `aliasPrefix` is trusted
 * server code, and lets two paths meet at a hub without alias collisions.
 */
export const compileTraversal = (
  from: Entity,
  steps: readonly RelationshipPathStep[],
  aliasPrefix: string,
  aliases?: {
    root?: string;
    leaf?: string;
    /**
     * The path's destination. Required only when the final step follows a
     * multi-target edge outward (an Image back to whatever it is attached to).
     */
    to?: Entity;
    /** A page-wide effective Expense assignment relation supplied by the caller. */
    expenseProjectRelation?: string;
    /**
     * Names a caller-registered `InheritedRelation` for an incoming inherited
     * edge. Matching a target against each source row's effective value inline
     * is not sargable, so the planner nests loops over the whole path; the
     * relation computes each effective value once and joins on equality.
     */
    inheritedRelation?: (entity: Entity, field: string) => string;
  },
): Traversal => {
  const rootTable = entityTable(from);
  const rootAlias = aliases?.root ?? `${aliasPrefix}0`;
  let currentTable = rootTable;
  let currentAlias = rootAlias;
  const hops: TraversalHop[] = [];
  const inheritedRelations: InheritedRelation[] = [];

  for (const [index, step] of steps.entries()) {
    const edge = EDGES.get(step.edge);
    if (!edge) throw new Error(`Unknown relatedness edge ${step.edge}`);
    const alias =
      index === steps.length - 1 && aliases?.leaf
        ? aliases.leaf
        : `${aliasPrefix}${index + 1}`;
    const outgoing = step.direction === "outgoing";
    const expected = outgoing ? [edge.sourceTable] : edge.targetTables;
    if (!expected.includes(currentTable)) {
      throw new Error(
        `Path ${step.edge} (${step.direction}) cannot follow ${currentTable}; expected ${expected.join(" | ")}`,
      );
    }
    const nextTable = outgoing
      ? outgoingTarget(
          edge,
          index === steps.length - 1 ? aliases?.to : undefined,
        )
      : edge.sourceTable;
    const mappedExpenseProject = mappedExpenseProjectAt(
      edge,
      outgoing,
      steps,
      index,
      aliases?.expenseProjectRelation,
    );
    const inherited =
      !outgoing && !mappedExpenseProject && aliases?.inheritedRelation
        ? inheritedEdge(edge)
        : null;
    if (inherited !== null && aliases?.inheritedRelation) {
      const relation = {
        name: aliases.inheritedRelation(inherited.entity, inherited.field),
        entity: inherited.entity,
        field: inherited.field,
        table: nextTable,
      };
      inheritedRelations.push(relation);
      hops.push({
        table: nextTable,
        relation: relation.name,
        alias,
        fromAlias: currentAlias,
        fromColumn: "id",
        toColumn: edge.sourceColumn,
        softDelete: edge.sourceSoftDeletable,
        condition: sql`${sql.raw(`${alias}."effectiveValue"`)} = ${sql.raw(`${currentAlias}."id"`)}`,
      });
      currentTable = nextTable;
      currentAlias = alias;
      continue;
    }
    hops.push({
      table: nextTable,
      relation: mappedExpenseProject
        ? aliases?.expenseProjectRelation
        : undefined,
      alias,
      fromAlias: currentAlias,
      fromColumn: outgoing ? edge.sourceColumn : "id",
      toColumn: outgoing ? "id" : edge.sourceColumn,
      softDelete: outgoing
        ? softDeleteForTable(nextTable)
        : edge.sourceSoftDeletable,
      condition: traversalEdgeCondition(
        edge,
        alias,
        currentAlias,
        outgoing,
        productScopedExpenseAt(steps, index),
        mappedExpenseProject,
      ),
    });
    currentTable = nextTable;
    currentAlias = alias;
  }

  const traversal = {
    rootTable,
    rootAlias,
    hops,
    leafTable: currentTable,
    leafAlias: currentAlias,
    usesExpenseProjectRelation: hops.some(
      (hop) =>
        hop.relation !== undefined &&
        hop.relation === aliases?.expenseProjectRelation,
    ),
    inheritedRelations,
  };
  return { ...traversal, joins: renderJoins(traversal) };
};

/** Each join is structurally parenthesized, so callers never inherit precedence. */
export const renderJoins = (traversal: Pick<Traversal, "hops">): SQL =>
  sql.join(
    traversal.hops.map(
      (hop) =>
        sql`JOIN ${sql.raw(`"${hop.relation ?? hop.table}"`)} ${sql.raw(hop.alias)} ON (${hop.condition}${
          hop.softDelete
            ? sql` AND ${sql.raw(`${hop.alias}."deletedAt"`)} IS NULL`
            : sql``
        })`,
    ),
    sql` `,
  );

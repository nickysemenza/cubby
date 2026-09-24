import type { Entity } from "@cubby/schemas/entity";
import type { RelationshipPathStep } from "@cubby/schemas/entity-integrity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { is, type SQL, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import * as schema from "~/server/db/schema";
import { effectiveExpenseProjectSql } from "~/server/repo/expense-inheritance";
import { expenseProjectAllocationSql } from "~/server/repo/expense-project-allocation";
import {
  effectiveTaskProjectSql,
  effectiveTaskSubjectProductSql,
} from "~/server/repo/task-project-inheritance";

interface EdgeSpec {
  edgeKey: string;
  sourceTable: string;
  sourceColumn: string;
  /**
   * One table for an ordinary FK. `EntityAttachment.subjectEntityId` names any
   * attachable entity, so it lists each; entity ids are unique across tables,
   * which keeps the join exact without a kind filter.
   */
  targetTables: readonly string[];
  sourceSoftDeletable: boolean;
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

export interface Traversal {
  rootTable: string;
  rootAlias: string;
  hops: readonly TraversalHop[];
  leafTable: string;
  leafAlias: string;
  joins: SQL;
  usesExpenseProjectRelation: boolean;
}

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

/** Relationship discovery follows effective assignment, including shared charges. */
function edgeCondition(
  edge: EdgeSpec,
  sourceAlias: string,
  targetAlias: string,
  productScopedExpense: boolean,
): SQL {
  const target = sql.raw(`${targetAlias}."id"`);
  if (edge.edgeKey === "Task.projectId")
    return sql`${effectiveTaskProjectSql(sourceAlias)} = ${target}`;
  if (edge.edgeKey === "Task.subjectProductId")
    return sql`${effectiveTaskSubjectProductSql(sourceAlias)} = ${target}`;
  // The database requires a product-linked Expense to be principal. For a
  // product-scoped path, allocation is therefore the scalar effective project.
  if (edge.edgeKey === "Expense.projectId" && productScopedExpense)
    return sql`${effectiveExpenseProjectSql(
      sourceAlias,
      sql`${sql.raw(`${targetAlias}."shortcode"`)} = 'PRJ-HSHD'`,
    )} = ${target}`;
  if (edge.edgeKey === "Expense.projectId")
    return sql`EXISTS (
    SELECT 1 FROM (${expenseProjectAllocationSql()}) attributed
    WHERE attributed."expenseId" = ${sql.raw(`${sourceAlias}."id"`)}
      AND attributed."projectId" = ${target}
  )`;
  return sql`${sql.raw(`${sourceAlias}."${edge.sourceColumn}"`)} = ${target}`;
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
  },
): Traversal => {
  const rootTable = entityTable(from);
  const rootAlias = aliases?.root ?? `${aliasPrefix}0`;
  let currentTable = rootTable;
  let currentAlias = rootAlias;
  const hops: TraversalHop[] = [];

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
    hops.push({
      table: nextTable,
      relation: mappedExpenseProject
        ? aliases.expenseProjectRelation
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
    usesExpenseProjectRelation: hops.some((hop) => hop.relation !== undefined),
  };
  return { ...traversal, joins: renderJoins(traversal) };
};

/** Each join is structurally parenthesized, so callers never inherit precedence. */
const renderJoins = (traversal: Pick<Traversal, "hops">): SQL =>
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

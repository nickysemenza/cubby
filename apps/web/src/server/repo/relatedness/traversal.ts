import type { Entity } from "@cubby/schemas/entity";
import type { RelationshipPathStep } from "@cubby/schemas/entity-integrity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { is, type SQL, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import {
  INCOMING_EDGES,
  type IncomingEdge,
} from "~/server/db/entity-incoming-edges";

interface EdgeSpec {
  edgeKey: string;
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  sourceSoftDeletable: boolean;
}

interface TraversalHop {
  table: string;
  alias: string;
  fromAlias: string;
  fromColumn: string;
  toColumn: string;
  softDelete: boolean;
}

export interface Traversal {
  rootTable: string;
  rootAlias: string;
  hops: readonly TraversalHop[];
  leafTable: string;
  leafAlias: string;
  joins: SQL;
}

const entityTable = (entity: Entity): string => {
  const table = entityManifest[entity].dbTable;
  if (!table)
    throw new Error(`Relatedness cannot traverse external entity ${entity}`);
  return table;
};

/** Drizzle is the source of real table/column facts; the manifest names targets. */
const edgeIndex = (): ReadonlyMap<string, EdgeSpec> => {
  const specs = new Map<string, EdgeSpec>();
  for (const [target, edges] of Object.entries(INCOMING_EDGES) as Array<
    [Entity, Record<string, IncomingEdge>]
  >) {
    for (const [edgeKey, edge] of Object.entries(edges)) {
      const column = edge.column;
      if (!is(column.table, PgTable)) {
        throw new Error(
          `Relatedness edge ${edgeKey} is not attached to a PgTable`,
        );
      }
      const config = getTableConfig(column.table);
      specs.set(edgeKey, {
        edgeKey,
        sourceTable: config.name,
        sourceColumn: column.name,
        targetTable: entityTable(target),
        sourceSoftDeletable: config.columns.some(
          (candidate) => candidate.name === "deletedAt",
        ),
      });
    }
  }
  return specs;
};

const EDGES = edgeIndex();

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

/**
 * Compile a manifest-only path into structural joins. `aliasPrefix` is trusted
 * server code, and lets two paths meet at a hub without alias collisions.
 */
export const compileTraversal = (
  from: Entity,
  steps: readonly RelationshipPathStep[],
  aliasPrefix: string,
): Traversal => {
  const rootTable = entityTable(from);
  const rootAlias = `${aliasPrefix}0`;
  let currentTable = rootTable;
  let currentAlias = rootAlias;
  const hops: TraversalHop[] = [];

  for (const [index, step] of steps.entries()) {
    const edge = EDGES.get(step.edge);
    if (!edge) throw new Error(`Unknown relatedness edge ${step.edge}`);
    const alias = `${aliasPrefix}${index + 1}`;
    const outgoing = step.direction === "outgoing";
    const expected = outgoing ? edge.sourceTable : edge.targetTable;
    if (currentTable !== expected) {
      throw new Error(
        `Path ${step.edge} (${step.direction}) cannot follow ${currentTable}; expected ${expected}`,
      );
    }
    const nextTable = outgoing ? edge.targetTable : edge.sourceTable;
    hops.push({
      table: nextTable,
      alias,
      fromAlias: currentAlias,
      fromColumn: outgoing ? edge.sourceColumn : "id",
      toColumn: outgoing ? "id" : edge.sourceColumn,
      softDelete: outgoing
        ? entityManifest[
            (Object.entries(entityManifest).find(
              ([, descriptor]) => descriptor.dbTable === nextTable,
            )?.[0] ?? from) as Entity
          ].softDelete
        : edge.sourceSoftDeletable,
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
  };
  return { ...traversal, joins: renderJoins(traversal) };
};

/** Each join is structurally parenthesized, so callers never inherit precedence. */
const renderJoins = (traversal: Pick<Traversal, "hops">): SQL =>
  sql.join(
    traversal.hops.map(
      (hop) =>
        sql`JOIN ${sql.raw(`"${hop.table}"`)} ${sql.raw(hop.alias)} ON (${sql.raw(
          `${hop.fromAlias}."${hop.fromColumn}"`,
        )} = ${sql.raw(`${hop.alias}."${hop.toColumn}"`)}${
          hop.softDelete
            ? sql` AND ${sql.raw(`${hop.alias}."deletedAt"`)} IS NULL`
            : sql``
        })`,
    ),
    sql` `,
  );

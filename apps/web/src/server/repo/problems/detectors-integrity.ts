/**
 * Referential-liveness audit: finds every LIVE row whose foreign key points at
 * a SOFT-DELETED target, for every incoming edge whose `liveness` rule in
 * `ENTITY_EDGE_SEMANTICS` is `must-target-live`.
 *
 * The invariant: soft delete (see the root CLAUDE.md "Soft Delete" section)
 * hides a row from normal queries but keeps it in the database, so nothing
 * downstream is supposed to notice — except a dangling pointer. A live
 * `PurchaseImage` still naming a soft-deleted `Purchase`, a live `Task` still
 * filed under a soft-deleted `Project`, and so on, are all evidence that some
 * removal path forgot to detach, re-point, or cascade-delete its dependents
 * before the CLAUDE.md "Removal-path invariant" or "Incoming-edge invariant"
 * were satisfied. Almost every edge in the system carries this rule; this
 * detector is the audit that catches a new removal path (or an old one,
 * missed) that skips it.
 *
 * **This is a REGRESSION GUARD, not a hypothetical.** Run against production
 * data on 2026-07-30 (the day this detector was written), it returned zero
 * violations: the only live rows pointing at soft-deleted targets anywhere in
 * the schema were the 12 `Ingredient.recipeId` tombstones — see below — and
 * every one of those is on the sole edge that is deliberately exempt. A
 * non-empty result from this detector is a real bug, not noise to tune away.
 *
 * **Why `Ingredient.recipeId` is exempt.** It is the one edge marked
 * `allow-target-deleted` in `ENTITY_EDGE_SEMANTICS`: deleting a recipe
 * deliberately preserves the recipe-as-ingredient pointer
 * (`preserve-sub-recipe-pointer` in `RECIPE_DELETE_EDGE_POLICY`,
 * `apps/web/src/server/repo/recipe/crud.ts`) so parent recipes that used the
 * deleted recipe as a sub-recipe can still resolve the tombstone for
 * staleness detection and cascading recompute, instead of silently losing an
 * ingredient line. Auditing it as a violation would be flagging intended
 * behavior as a bug, so it is skipped entirely rather than reported and
 * explained away.
 *
 * **Why `Location.parentId` is audited despite having no DB-level FK.** It is
 * `unconstrained: true` in `INCOMING_EDGES` — the parent/child location tree
 * is walked via app code and `relations()`, not an enforced constraint — but
 * that only means Postgres won't stop a dangling pointer from being written;
 * it says nothing about whether one *should* exist. The edge's `liveness` is
 * still `must-target-live` (a sub-location naming a soft-deleted parent is
 * exactly the same class of bug as any FK-backed edge), so it stays in this
 * audit. `unconstrained` and `liveness` are orthogonal: one is about storage
 * enforcement, the other about domain correctness.
 *
 * **Why raw SQL instead of the Drizzle query builder.** Three edges are
 * self-referential (`Location.parentId`, `Project.parentProjectId`,
 * `Task.parentTaskId`) — source and target are the same table, which the
 * builder's `.innerJoin()` can only express with explicit table aliasing that
 * `INCOMING_EDGES`' generic `{ column }` shape doesn't carry. Worse,
 * interpolating a Drizzle column object into a `sql` select field silently
 * drops its table-qualifying prefix (the `drizzle-buildSelection-strips-
 * prefixes` hazard — it has already produced four bugs in this repo,
 * including silent self-joins), which is precisely the failure mode a
 * self-join query is most exposed to. Building one explicit `UNION ALL` of
 * hand-written, alias-qualified SQL fragments — table and column names always
 * routed through `sql.identifier()`, values always bound parameters — sidesteps
 * both problems and keeps every one of the 34 branches visually inspectable.
 */

import type { Entity } from "@cubby/schemas/entity";
import type {
  EdgeRole,
  EdgeSemantics,
  ReferentialLivenessViolation,
} from "@cubby/schemas/entity-integrity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { is, type SQL, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { Database } from "~/server/db";
import { ENTITY_EDGE_SEMANTICS } from "~/server/db/entity-edge-semantics";
import {
  INCOMING_EDGES,
  type IncomingEdge,
} from "~/server/db/entity-incoming-edges";
import { getDb } from "~/server/repo/database-helpers";

/** Cap on returned rows per edge — a pathological backlog can't blow up the response. */
const ROW_CAP = 50;

/** Everything one SQL branch needs to check one `must-target-live` edge. */
interface EdgeAuditSpec {
  edgeKey: string;
  targetEntity: Entity;
  role: EdgeRole;
  label: string;
  sourceTableName: string;
  sourceColumnName: string;
  targetTableName: string;
  /** Whether the source table itself has a `deletedAt` column to guard on. */
  sourceSoftDeletable: boolean;
}

/** Source tables with no `deletedAt` column — hard-delete-only, so no `s."deletedAt" IS NULL` guard applies. */
const EXPECTED_HARD_DELETE_ONLY_TABLES = new Set([
  "ProjectDependency",
  "TaskDependency",
]);

/** The must-target-live edges this audit checks, derived (not hand-maintained) should equal this. */
const EXPECTED_EDGE_COUNT = 34;

/**
 * Derive one {@link EdgeAuditSpec} per `must-target-live` edge in
 * `INCOMING_EDGES`, skipping `allow-target-deleted` edges.
 *
 * Every derived fact is asserted against an independent source rather than
 * trusted: the source table/column names come from the Drizzle column itself
 * (`column.table` / `column.name`), then checked against the edge's own key
 * string — a mis-derivation (wrong table, wrong column) throws instead of
 * silently querying the wrong data. The two structural counts this repo's
 * history depends on (34 audited edges, exactly `ProjectDependency` +
 * `TaskDependency` as the hard-delete-only source tables) are asserted at the
 * end for the same reason: drift should fail loudly, not read as "0 problems
 * found" against a query that quietly stopped covering what it used to.
 */
function buildEdgeAuditSpecs(): EdgeAuditSpec[] {
  const specs: EdgeAuditSpec[] = [];

  for (const [targetEntity, edgeMap] of Object.entries(INCOMING_EDGES) as [
    Entity,
    Record<string, IncomingEdge>,
  ][]) {
    const semanticsMap = ENTITY_EDGE_SEMANTICS[targetEntity] as Record<
      string,
      EdgeSemantics
    >;

    for (const [edgeKey, edge] of Object.entries(edgeMap)) {
      const semantics = semanticsMap[edgeKey];
      if (!semantics) {
        throw new Error(
          `No ENTITY_EDGE_SEMANTICS entry for "${edgeKey}" (target entity "${targetEntity}") — ` +
            "INCOMING_EDGES and ENTITY_EDGE_SEMANTICS have drifted out of key parity.",
        );
      }
      // `Ingredient.recipeId` — deliberately preserved tombstone, not a bug.
      if (semantics.liveness.kind === "allow-target-deleted") continue;

      const column = edge.column;
      if (!is(column.table, PgTable)) {
        throw new Error(
          `Edge "${edgeKey}"'s column is not attached to a PgTable — cannot derive its source table.`,
        );
      }
      const sourceTableConfig = getTableConfig(column.table);
      const sourceTableName = sourceTableConfig.name;
      const sourceColumnName = column.name;

      const derivedKey = `${sourceTableName}.${sourceColumnName}`;
      if (derivedKey !== edgeKey) {
        throw new Error(
          `INCOMING_EDGES key "${edgeKey}" does not match its column's actual table/column ` +
            `("${derivedKey}") — this edge is mis-keyed and would audit the wrong table.`,
        );
      }

      const targetTableName = entityManifest[targetEntity].dbTable;
      if (!targetTableName) {
        throw new Error(
          `Entity "${targetEntity}" has an incoming edge ("${edgeKey}") but no dbTable in ` +
            "entityManifest — only usda-food has no dbTable, and it declares no edges.",
        );
      }

      const sourceSoftDeletable = sourceTableConfig.columns.some(
        (c) => c.name === "deletedAt",
      );

      specs.push({
        edgeKey,
        targetEntity,
        role: semantics.role,
        label: semantics.label,
        sourceTableName,
        sourceColumnName,
        targetTableName,
        sourceSoftDeletable,
      });
    }
  }

  if (specs.length !== EXPECTED_EDGE_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_EDGE_COUNT} must-target-live edges, derived ${specs.length}. ` +
        "An edge was added/removed/reclassified in INCOMING_EDGES or ENTITY_EDGE_SEMANTICS " +
        "without updating this audit's expected count.",
    );
  }

  const hardDeleteOnlyTables = new Set(
    specs.filter((s) => !s.sourceSoftDeletable).map((s) => s.sourceTableName),
  );
  const sameSize =
    hardDeleteOnlyTables.size === EXPECTED_HARD_DELETE_ONLY_TABLES.size;
  const sameMembers = [...hardDeleteOnlyTables].every((t) =>
    EXPECTED_HARD_DELETE_ONLY_TABLES.has(t),
  );
  if (!sameSize || !sameMembers) {
    throw new Error(
      `Expected exactly {${[...EXPECTED_HARD_DELETE_ONLY_TABLES].join(", ")}} as the hard-delete-only ` +
        `source tables, found {${[...hardDeleteOnlyTables].join(", ")}}. A source table's soft-delete ` +
        "status changed — update EXPECTED_HARD_DELETE_ONLY_TABLES if that's intended.",
    );
  }

  return specs;
}

/**
 * One `SELECT edgeKey, sourceId, targetId ... LIMIT` branch for a
 * violation-detail row.
 *
 * The surrounding parentheses are load-bearing: Postgres parses a bare `LIMIT`
 * on a `UNION ALL` arm as the limit of the whole union, and rejects it outright
 * when more arms follow (`syntax error at or near "UNION"`). Without them this
 * query throws on every call in every environment, regardless of data — which
 * is exactly what it did until the integration test ran it for real.
 */
function detailBranch(spec: EdgeAuditSpec): SQL {
  return sql`(
    SELECT ${spec.edgeKey}::text AS "edgeKey",
           s.id::text AS "sourceId",
           t.id::text AS "targetId"
    FROM ${sql.identifier(spec.sourceTableName)} s
    JOIN ${sql.identifier(spec.targetTableName)} t
      ON t.id = s.${sql.identifier(spec.sourceColumnName)}
    WHERE t."deletedAt" IS NOT NULL
    ${spec.sourceSoftDeletable ? sql`AND s."deletedAt" IS NULL` : sql``}
    LIMIT ${ROW_CAP}
  )`;
}

/** One `SELECT edgeKey, count(*)` branch — the true count behind a possibly-capped detail result. */
function countBranch(spec: EdgeAuditSpec): SQL {
  return sql`
    SELECT ${spec.edgeKey}::text AS "edgeKey",
           count(*)::int AS "count"
    FROM ${sql.identifier(spec.sourceTableName)} s
    JOIN ${sql.identifier(spec.targetTableName)} t
      ON t.id = s.${sql.identifier(spec.sourceColumnName)}
    WHERE t."deletedAt" IS NOT NULL
    ${spec.sourceSoftDeletable ? sql`AND s."deletedAt" IS NULL` : sql``}
  `;
}

function describeViolation(
  spec: EdgeAuditSpec,
  shown: number,
  trueCount: number,
): string {
  const base =
    `A live ${spec.sourceTableName} row (${spec.label}) still points at a ` +
    `soft-deleted ${spec.targetEntity} — via ${spec.edgeKey}.`;
  if (trueCount > shown) {
    return `${base} Showing ${shown} of ${trueCount} total violations on this edge (capped at ${ROW_CAP}).`;
  }
  return base;
}

type DetailRow = Record<string, unknown> & {
  edgeKey: string;
  sourceId: string;
  targetId: string;
};

type CountRow = Record<string, unknown> & {
  edgeKey: string;
  count: number;
};

/**
 * Every live row whose FK points at a soft-deleted target, across all 34
 * `must-target-live` incoming edges. See the file-level doc comment for the
 * invariant, why it's a regression guard, and the two audit exemptions
 * (`Ingredient.recipeId` skipped entirely, `Location.parentId` included
 * despite being unconstrained).
 *
 * Two round trips total, not one per edge: one `UNION ALL` for the (capped)
 * violation rows, one `UNION ALL` for the true per-edge count, run
 * concurrently. When an edge's true count exceeds what was returned, that
 * edge's violations say so in their `description`.
 */
export const findReferentialLivenessViolations = async (
  db: Database,
): Promise<ReferentialLivenessViolation[]> => {
  const specs = buildEdgeAuditSpecs();
  const specByKey = new Map(specs.map((s) => [s.edgeKey, s]));

  const dbClient = getDb(db);
  const detailQuery = sql.join(
    specs.map((s) => detailBranch(s)),
    sql` UNION ALL `,
  );
  const countQuery = sql.join(
    specs.map((s) => countBranch(s)),
    sql` UNION ALL `,
  );

  const [detailResult, countResult] = await Promise.all([
    dbClient.execute<DetailRow>(detailQuery),
    dbClient.execute<CountRow>(countQuery),
  ]);

  const countByKey = new Map(
    countResult.rows.map((r) => [r.edgeKey, Number(r.count)]),
  );
  const shownByKey = new Map<string, number>();
  for (const row of detailResult.rows) {
    shownByKey.set(row.edgeKey, (shownByKey.get(row.edgeKey) ?? 0) + 1);
  }

  return detailResult.rows.map((row): ReferentialLivenessViolation => {
    const spec = specByKey.get(row.edgeKey);
    if (!spec) {
      throw new Error(
        `Detail row references unknown edge "${row.edgeKey}" — the detail and spec queries have drifted.`,
      );
    }
    const shown = shownByKey.get(row.edgeKey) ?? 0;
    const trueCount = countByKey.get(row.edgeKey) ?? shown;

    return {
      edgeKey: spec.edgeKey,
      role: spec.role,
      targetEntity: spec.targetEntity,
      targetId: row.targetId,
      sourceTable: spec.sourceTableName,
      sourceId: row.sourceId,
      description: describeViolation(spec, shown, trueCount),
    };
  });
};

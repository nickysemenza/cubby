import type { Entity } from "@cubby/schemas/entity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import * as schema from "~/server/db/schema";

const entities = Object.keys(entityManifest) as Entity[];

// Every real pgTable schema.ts exports — entity tables (Recipe, Product, …)
// AND join/child tables (RecipeSection, ProductImage, PurchaseImage, …) and
// the Better-Auth tables alike. Sourcing FK introspection from here (not a
// hand-picked subset of entity tables) is what makes a join table
// indistinguishable from an entity table AS A SOURCE — the old hand-maintained
// `ENTITY_TABLE` iterated only entity tables, so it was structurally blind to
// `PurchaseImage.imageId` (a join-table column) ever going undeclared. See the
// file-level doc comment on entity-incoming-edges.ts for the fuller rationale.
const ALL_TABLES: PgTable[] = Object.values(schema).filter((v) =>
  is(v, PgTable),
) as PgTable[];

// entity -> its own local pgTable, resolved by matching the manifest's
// declared `dbTable` name against the real exported tables — derived, not
// hand-maintained, so the two can't quietly drift apart (see the first test).
const ENTITY_TABLE: Partial<Record<Entity, PgTable>> = {};
for (const entity of entities) {
  const dbTable = entityManifest[entity].dbTable;
  if (!dbTable) continue;
  const table = ALL_TABLES.find((t) => getTableConfig(t).name === dbTable);
  if (table) ENTITY_TABLE[entity] = table;
}

// pgTable name (e.g. "Purchase") -> entity (e.g. "purchase"), for resolving an
// FK's target table back to the entity it belongs to (only entities have a
// local table; join/child tables never appear on the right-hand side here).
const ENTITY_BY_TABLE = new Map<string, Entity>();
for (const [entity, table] of Object.entries(ENTITY_TABLE) as [
  Entity,
  PgTable,
][]) {
  ENTITY_BY_TABLE.set(getTableConfig(table).name, entity);
}

// FK targets that are real pgTables but deliberately NOT entities — each
// needs a one-line reason here, which is the point of assertion 3 below: a
// NEW non-entity FK target fails until someone adds (and justifies) an entry.
//
// schema.ts re-exports the Better-Auth / OAuth-provider tables (auth.schema.ts)
// for the drizzle adapter, so "every pgTable exported from schema.ts" (the
// introspection source; see ALL_TABLES above) pulls in that whole auth
// sub-graph too — not just `user` (AuditLog.userId's target). Auth's own
// internal edges (session -> user, oauth_refresh_token -> oauth_client, etc.)
// all need an entry here as well, since none of them are app-domain entities.
const NON_ENTITY_FK_TARGETS: Record<string, string> = {
  // Owned wholly by its parent recipe (Recipe -> RecipeSection ->
  // RecipeSectionIngredient) — not independently addressable, so it never
  // graduated to its own entity.
  RecipeSection: "owned wholly by its recipe, not independently addressable",
  // Background-job bookkeeping (queue/inline processing metadata), not a
  // domain entity a user ever looks up by id.
  BackgroundBatch: "operational bookkeeping, not a domain entity",
  // Better-Auth / OAuth-provider tables (auth.schema.ts) — infrastructure for
  // sign-in and MCP OAuth 2.1, not app-domain entities. Referenced (directly
  // or transitively) by AuditLog.userId and the oauth_* tables' own edges.
  user: "Better-Auth's own table, referenced only by AuditLog.userId",
  session: "Better-Auth's own table (login sessions)",
  oauth_client: "OAuth 2.1 provider table (registered MCP clients)",
  oauth_refresh_token: "OAuth 2.1 provider table (issued refresh tokens)",
};

interface IntrospectedEdge {
  /** `${sourceTableName}.${sourceColumnName}`, e.g. "PurchaseImage.imageId". */
  key: string;
  targetTableName: string;
  targetEntity: Entity | undefined;
}

/** Every FK column in schema.ts, source table included (join tables too). */
function introspectFkEdges(): IntrospectedEdge[] {
  const edges: IntrospectedEdge[] = [];
  for (const table of ALL_TABLES) {
    const sourceTableName = getTableConfig(table).name;
    for (const fk of getTableConfig(table).foreignKeys) {
      const ref = fk.reference();
      const targetTableName = getTableConfig(ref.foreignTable).name;
      const targetEntity = ENTITY_BY_TABLE.get(targetTableName);
      for (const column of ref.columns) {
        edges.push({
          key: `${sourceTableName}.${column.name}`,
          targetTableName,
          targetEntity,
        });
      }
    }
  }
  return edges;
}

describe("entity manifest FK guard", () => {
  it("every entity's declared dbTable resolves to a real pgTable in schema.ts", () => {
    for (const entity of entities) {
      const dbTable = entityManifest[entity].dbTable;
      if (!dbTable) continue;
      const table = ENTITY_TABLE[entity];
      expect(
        table,
        `entityManifest.${entity}.dbTable = "${dbTable}" does not match any pgTable exported from schema.ts`,
      ).toBeDefined();
      if (!table) continue;
      expect(getTableConfig(table).name).toBe(dbTable);
    }
  });

  it("every FK pointing at an entity's table is declared in INCOMING_EDGES", () => {
    const edges = introspectFkEdges().filter((e) => e.targetEntity);
    // Introspection actually found FKs targeting entities — an empty result
    // here would mean this test is vacuously (and silently) passing.
    expect(edges.length).toBeGreaterThan(0);
    const missing = edges
      .filter((e) => !(e.key in INCOMING_EDGES[e.targetEntity as Entity]))
      .map(
        (e) =>
          `\`${e.key}\` references ${e.targetTableName} but is not declared in \`INCOMING_EDGES.${e.targetEntity}\`.`,
      );
    expect(missing).toEqual([]);
  });

  it("every declared INCOMING_EDGES entry matches a real FK, or is marked unconstrained", () => {
    const found = new Set(introspectFkEdges().map((e) => e.key));
    const missing: string[] = [];
    for (const entity of entities) {
      for (const [key, edge] of Object.entries(INCOMING_EDGES[entity])) {
        if (edge.unconstrained) continue;
        if (!found.has(key)) {
          missing.push(
            `INCOMING_EDGES.${entity}["${key}"] has no matching FK in schema.ts — a typo, a renamed column, or it should be marked \`unconstrained: true\`.`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every FK target is either an entity or an allowlisted non-entity table", () => {
    const unexplained = introspectFkEdges()
      .filter(
        (e) => !e.targetEntity && !(e.targetTableName in NON_ENTITY_FK_TARGETS),
      )
      .map(
        (e) =>
          `\`${e.key}\` references ${e.targetTableName}, which is neither an entity table nor in NON_ENTITY_FK_TARGETS — add it there with a one-line reason, or point it at an entity.`,
      );
    expect(unexplained).toEqual([]);
  });
});

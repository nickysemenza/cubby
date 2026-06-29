import type { Entity } from "@cubby/schemas/entity";
import {
  entityManifest,
  entityReferences,
} from "@cubby/schemas/entity-manifest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  cookbook,
  image,
  ingredient,
  inventoryEntry,
  location,
  meal,
  product,
  recipe,
} from "~/server/db/schema";

// The Drizzle table backing each entity that has a local table.
const ENTITY_TABLE: Partial<Record<Entity, PgTable>> = {
  product,
  recipe,
  ingredient,
  cookbook,
  location,
  inventory: inventoryEntry,
  meal,
  image,
};

// pgTable name -> entity (e.g. "InventoryEntry" -> "inventory"); cross-checked
// against the manifest's declared dbTable so the two can't disagree.
const ENTITY_BY_TABLE = new Map<string, Entity>();
for (const [entity, table] of Object.entries(ENTITY_TABLE) as [
  Entity,
  PgTable,
][]) {
  ENTITY_BY_TABLE.set(getTableConfig(table).name, entity);
}

/** Direct entity→entity foreign-key edges declared on the entity tables. */
function directFkEdges(): Array<[Entity, Entity]> {
  const edges: Array<[Entity, Entity]> = [];
  for (const [entity, table] of Object.entries(ENTITY_TABLE) as [
    Entity,
    PgTable,
  ][]) {
    for (const fk of getTableConfig(table).foreignKeys) {
      const targetName = getTableConfig(fk.reference().foreignTable).name;
      const target = ENTITY_BY_TABLE.get(targetName);
      if (target && target !== entity) edges.push([entity, target]);
    }
  }
  return edges;
}

describe("entity manifest FK guard", () => {
  it("dbTable names match the actual pgTable names", () => {
    for (const [entity, table] of Object.entries(ENTITY_TABLE) as [
      Entity,
      PgTable,
    ][]) {
      expect(entityManifest[entity].dbTable).toBe(getTableConfig(table).name);
    }
  });

  it("every direct entity→entity FK in schema.ts is in the manifest references", () => {
    // Join-table edges (product→image via productImage), cross-system links
    // (product→usda-food via fdc_id), and the sub-recipe self-ref stay manual —
    // this guards only the direct FK columns, the easiest ones to forget.
    const edges = directFkEdges();
    expect(edges.length).toBeGreaterThan(0); // introspection actually found FKs
    const missing = edges
      .filter(([from, to]) => !entityReferences(from).includes(to))
      .map(([from, to]) => `${from} → ${to}`);
    expect(missing).toEqual([]);
  });
});

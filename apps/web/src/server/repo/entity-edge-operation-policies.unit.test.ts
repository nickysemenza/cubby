import type { Entity } from "@cubby/schemas/entity";
import {
  allEntities,
  auditableEntities,
  entityManifest,
} from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";

import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import { ENTITY_LIFECYCLE_REGISTRY } from "~/server/repo/entity-lifecycle-registry";
import { INGREDIENT_DELETE_EDGE_POLICY } from "~/server/repo/ingredient/deletion";
import { INGREDIENT_MERGE_EDGE_POLICY } from "~/server/repo/ingredient/merge";
import { PRODUCT_EDGE_ROLES } from "~/server/repo/product/edge-roles";
import { SHORTCODE_TABLE } from "~/server/repo/shortcode-tables";

describe("incoming-edge operation policies", () => {
  it("keeps audited removal entities aligned with the shortcode table roster", () => {
    // Image is hard-deleted and Run is immutable history.
    expect([...auditableEntities].sort()).toEqual(
      Object.keys(SHORTCODE_TABLE)
        .filter((entity) => entity !== "image" && entity !== "run")
        .sort(),
    );
  });

  // Iterates ENTITY_LIFECYCLE_REGISTRY itself rather than a hand-listed
  // subset, so every declared policy is covered automatically — a policy
  // added to the registry (or dropped from it) changes what this loop checks
  // without anyone needing to remember to update a parallel list here.
  for (const { entity, operation, policy } of ENTITY_LIFECYCLE_REGISTRY) {
    it(`${entity} ${operation} classifies every ${entity} incoming edge exactly once`, () => {
      expect(Object.keys(policy).sort()).toEqual(
        Object.keys(INCOMING_EDGES[entity]).sort(),
      );
    });
  }

  // PRODUCT_EDGE_ROLES isn't an operation disposition and has no
  // ENTITY_LIFECYCLE_REGISTRY entry of its own — it's the stable role
  // classification every product incoming edge carries (via
  // ENTITY_EDGE_SEMANTICS.product), which `isRetainingEdgeKey` reads to
  // decide what `deleteProducts`/`findOrphanedProducts` do — so it needs its
  // own exhaustiveness case here.
  it("product edge roles classifies every product incoming edge exactly once", () => {
    expect(Object.keys(PRODUCT_EDGE_ROLES).sort()).toEqual(
      Object.keys(INCOMING_EDGES.product).sort(),
    );
  });

  it("blocks ingredient deletion and re-points merges for meal food entries", () => {
    expect(
      INGREDIENT_DELETE_EDGE_POLICY["MealFoodEntry.ingredientId"].effect,
    ).toBe("block");
    expect(
      INGREDIENT_MERGE_EDGE_POLICY["MealFoodEntry.ingredientId"].effect,
    ).toBe("repoint");
  });
});

/**
 * `ENTITY_LIFECYCLE_REGISTRY` is mostly derived, not hand-assembled:
 * `entity-lifecycle-registry.ts` builds one entry per
 * `generatedEntityKernelEntities` member straight off the compiled
 * `ENTITY_KERNEL_BINDINGS` (a read-only entity's binding still carries the
 * policy its workflow deletes under: cookbook).
 * Nothing forces a new `entityManifest` lifecycle claim to get a matching
 * kernel binding, though, so this is the runtime guard for that: every entity
 * whose `lifecycle.delete` is non-null must have a `"delete"` entry here (and
 * vice versa — no entry for an operation the manifest doesn't claim), and
 * likewise for `lifecycle.merge`.
 */
describe("ENTITY_LIFECYCLE_REGISTRY matches entityManifest lifecycle claims", () => {
  const hasEntry = (entity: Entity, operation: "delete" | "merge") =>
    ENTITY_LIFECYCLE_REGISTRY.some(
      (e) => e.entity === entity && e.operation === operation,
    );

  // Accumulated rather than one `it` per entity per operation: a drift usually
  // lands on several entities at once (a registry rebuild, a manifest sweep),
  // and naming all of them in one failure beats reading them off ~38 separate
  // red lines.
  const drift = (
    operation: "delete" | "merge",
    claims: (entity: Entity) => boolean,
  ) =>
    allEntities
      .filter((entity) => hasEntry(entity, operation) !== claims(entity))
      .map(
        (entity) =>
          `${entity}: registry ${hasEntry(entity, operation) ? "has" : "lacks"} a "${operation}" entry, manifest ${claims(entity) ? "claims" : "does not claim"} one`,
      );

  it('"delete" entries match lifecycle.delete, entity for entity', () => {
    expect(
      drift(
        "delete",
        (entity) => entityManifest[entity].lifecycle.delete !== null,
      ),
    ).toEqual([]);
  });

  it('"merge" entries match lifecycle.merge, entity for entity', () => {
    expect(
      drift("merge", (entity) => entityManifest[entity].lifecycle.merge),
    ).toEqual([]);
  });

  it("has no duplicate (entity, operation) entries", () => {
    const keys = ENTITY_LIFECYCLE_REGISTRY.map(
      (e) => `${e.entity}:${e.operation}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

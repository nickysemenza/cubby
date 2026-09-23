import type { Entity } from "@cubby/schemas/entity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { describe, expect, expectTypeOf, it } from "vitest";

import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import { ENTITY_LIFECYCLE_REGISTRY } from "~/server/repo/entity-lifecycle-registry";
import { INGREDIENT_DELETE_EDGE_POLICY } from "~/server/repo/ingredient/deletion";
import { INGREDIENT_MERGE_EDGE_POLICY } from "~/server/repo/ingredient/merge";
import {
  isRetainingEdgeKey,
  PRODUCT_DELETE_EDGE_POLICY,
  PRODUCT_EDGE_ROLES,
} from "~/server/repo/product/edge-roles";
import type { ProductRetainingEdgeKey } from "~/server/repo/product/edge-roles";

describe("incoming-edge operation policies", () => {
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
 * The retaining set decides whether a product can be deleted and whether
 * `findOrphanedProducts` will offer it for one-click deletion, so it is pinned
 * by value — not just by "whatever the roles happen to say". Moving
 * `ProductImage.productId` from the product-local `metadata` role to the shared
 * `media` role would have silently changed this set under the old
 * `!== "metadata"` filter; this test is what makes that a failure instead.
 */
describe("product retaining edges", () => {
  const RETAINING = [
    // A book Product a Cookbook claims as its physical copy. Retaining, like
    // Location.productId, because the policy vocabulary has no set-null effect
    // and the only non-blocking alternatives would soft-delete the cookbook
    // along with every recipe it imported.
    "Cookbook.productId",
    "Expense.productId",
    "ImportRunTarget.productId",
    "InventoryEntry.productId",
    "Location.productId",
    "MealFoodEntry.productId",
    "Planting.sourceProductId",
    "ProductComponent.componentProductId",
    "ProjectToolUsage.productId",
    "PurchaseProduct.productId",
    "Task.subjectProductId",
    "WishCandidate.productId",
    // A device's linked hardware. Retaining by role (a device is real
    // evidence the product still matters), but — unlike every other entry
    // here — NOT blocking: it's the first retaining edge the policy
    // vocabulary can actually clear (`effect: "detach"`), so it is excluded
    // from BLOCKING below rather than forcing the delete to fail.
    "Device.productId",
    // A photo group proposal's chosen Product: retaining for orphan
    // detection while proposed, but detached (not blocking) on delete.
    "PhotoGroupProposal.productId",
  ] as const;

  // Every retaining edge except the two that detach instead of blocking —
  // see their comments in RETAINING above.
  const DETACHING = new Set([
    "Device.productId",
    "PhotoGroupProposal.productId",
  ]);
  const BLOCKING = RETAINING.filter((key: string) => !DETACHING.has(key));

  it("retains exactly the acquisition, history, association, reference and usage edges", () => {
    expect(
      Object.keys(PRODUCT_EDGE_ROLES).filter(isRetainingEdgeKey).sort(),
    ).toEqual([...RETAINING].sort());
  });

  it("blocks deletion on exactly those edges, and no others", () => {
    expect(
      Object.entries(PRODUCT_DELETE_EDGE_POLICY)
        .filter(([, d]) => d.effect === "block")
        .map(([key]) => key)
        .sort(),
    ).toEqual([...BLOCKING].sort());
  });

  /**
   * Type-level backstop for the ENTITY_EDGES refactor: `ProductRetainingEdgeKey`
   * selects keys by testing each edge's literal `role` against `RetainingRole`
   * (`repo/product/edge-roles.ts`). That only works while
   * `ENTITY_EDGE_SEMANTICS.product`'s per-key `role` stays each edge's own
   * literal type — if the projection that builds `ENTITY_EDGE_SEMANTICS` ever
   * widened it to the general `EdgeRole` union, every key's `extends
   * RetainingRole` check would fail and this type would silently become
   * `never`, compiling cleanly while making every product edge look
   * non-retaining. Pinned by exact union, not just "is not never", so a
   * mis-classified edge (one added to or dropped from RETAINING above) fails
   * here too.
   */
  it("ProductRetainingEdgeKey stays the same literal-key union, not never", () => {
    expectTypeOf<ProductRetainingEdgeKey>().not.toEqualTypeOf<never>();
    expectTypeOf<ProductRetainingEdgeKey>().toEqualTypeOf<
      (typeof RETAINING)[number]
    >();
  });
});

/**
 * `ENTITY_LIFECYCLE_REGISTRY` is mostly derived, not hand-assembled:
 * `entity-lifecycle-registry.ts` builds one entry per
 * `generatedEntityKernelEntities` member straight off the compiled
 * `ENTITY_KERNEL_BINDINGS`, and hand-adds exactly one more (`cookbook`
 * delete, the sole workflow-owned lifecycle operation outside the kernel).
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

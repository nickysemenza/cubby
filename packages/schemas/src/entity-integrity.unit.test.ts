import { describe, expect, it } from "vitest";
import { previewOperationInputSchema } from "./entity-integrity";

/**
 * `previewOperationInputSchema` used to be a top-level `z.union` whose 19
 * members enforced these rules structurally. It had to become a flat object —
 * MCP requires `type: "object"` with real `properties`, and a union (plain or
 * discriminated) serializes to a top-level `anyOf`, which made the tool
 * uncallable. Every rule the union got for free now lives in one `superRefine`,
 * so each branch needs an explicit test: a rule that silently stops firing here
 * lets a malformed destructive-operation preview through validation.
 */

const ok = (input: unknown) => previewOperationInputSchema.safeParse(input);
/** The `path` of every issue, so a test pins WHICH rule fired, not just that one did. */
const errorPaths = (input: unknown): string[] => {
  const result = ok(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
};

describe("previewOperationInputSchema", () => {
  it("rejects delete outright — deletes have no preview any more", () => {
    // Deletes used to be the largest branch here (ids, per-entity prefix
    // checks, the image shortcode/uuid split). That planner is gone: a delete
    // mutation's own structured refusal is the contract now, so "delete" isn't
    // even a member of the `operation` enum any more.
    expect(
      ok({ operation: "delete", entity: "product", ids: ["PRD-2CRC"] }).success,
    ).toBe(false);
  });

  describe("merge", () => {
    it("accepts mergeIds, with or without keepId", () => {
      expect(
        ok({
          operation: "merge",
          entity: "ingredient",
          mergeIds: ["ING-2CRC", "ING-2CRD"],
        }).success,
      ).toBe(true);
      expect(
        ok({
          operation: "merge",
          entity: "vendor",
          mergeIds: ["VEN-2CRC"],
          keepId: "VEN-2CRD",
        }).success,
      ).toBe(true);
    });

    // Was `product` until product merge shipped. Pick an entity with no merge
    // implementation, or this silently stops testing the allowlist at all.
    it("rejects an entity that only supports delete", () => {
      expect(
        errorPaths({
          operation: "merge",
          entity: "location",
          mergeIds: ["LOC-2CRC"],
        }),
      ).toContain("entity");
    });

    it("accepts product, which merges as of the shared merge core", () => {
      expect(
        ok({
          operation: "merge",
          entity: "product",
          mergeIds: ["PRD-2CRC", "PRD-2CRD"],
          keepId: "PRD-2CRE",
        }).success,
      ).toBe(true);
    });

    it("requires mergeIds", () => {
      expect(
        errorPaths({ operation: "merge", entity: "ingredient" }),
      ).toContain("mergeIds");
    });

    it("requires mergeIds to be distinct", () => {
      expect(
        errorPaths({
          operation: "merge",
          entity: "ingredient",
          mergeIds: ["ING-2CRC", "ING-2CRC"],
        }),
      ).toContain("mergeIds");
    });

    it("rejects a keepId that also appears in mergeIds", () => {
      expect(
        errorPaths({
          operation: "merge",
          entity: "ingredient",
          mergeIds: ["ING-2CRC", "ING-2CRD"],
          keepId: "ING-2CRC",
        }),
      ).toContain("keepId");
    });

    it("prefix-checks mergeIds and keepId against the entity", () => {
      expect(
        errorPaths({
          operation: "merge",
          entity: "ingredient",
          mergeIds: ["PRD-2CRC"],
        }),
      ).toContain("mergeIds.0");
      expect(
        errorPaths({
          operation: "merge",
          entity: "ingredient",
          mergeIds: ["ING-2CRC"],
          keepId: "PRD-2CRD",
        }),
      ).toContain("keepId");
    });
  });

  describe("attach / detach", () => {
    it("accepts a parent whose prefix matches `entity`, for all three families", () => {
      for (const [entity, parentId] of [
        ["product", "PRD-2CRC"],
        ["project", "PRJ-2CRC"],
        ["purchase", "PUR-2CRC"],
      ] as const) {
        for (const operation of ["attach", "detach"] as const) {
          expect(
            ok({ operation, entity, parentId, productIds: ["PRD-2CRD"] })
              .success,
            `${operation} ${entity}`,
          ).toBe(true);
        }
      }
    });

    it("rejects an entity with no product relation", () => {
      expect(
        errorPaths({
          operation: "attach",
          entity: "recipe",
          parentId: "PRD-2CRC",
          productIds: ["PRD-2CRD"],
        }),
      ).toContain("entity");
    });

    it("rejects a parentId whose prefix disagrees with `entity`", () => {
      expect(
        errorPaths({
          operation: "attach",
          entity: "project",
          parentId: "PUR-2CRC",
          productIds: ["PRD-2CRD"],
        }),
      ).toContain("parentId");
    });

    it("requires both relation fields, and refuses the merge ones", () => {
      expect(errorPaths({ operation: "attach", entity: "product" })).toEqual(
        expect.arrayContaining(["parentId", "productIds"]),
      );
      // Silently ignoring a field that belongs to another operation is how a
      // caller ends up believing it did something.
      expect(
        errorPaths({
          operation: "detach",
          entity: "product",
          parentId: "PRD-2CRC",
          productIds: ["PRD-2CRD"],
          mergeIds: ["PRD-2CRE"],
        }),
      ).toContain("mergeIds");
    });

    it("refuses the relation fields on a merge", () => {
      expect(
        errorPaths({
          operation: "merge",
          entity: "product",
          mergeIds: ["PRD-2CRC"],
          keepId: "PRD-2CRD",
          parentId: "PRD-2CRE",
        }),
      ).toContain("parentId");
    });
  });

  it("rejects an unknown operation or entity outright", () => {
    expect(
      ok({ operation: "archive", entity: "product", mergeIds: ["PRD-2CRC"] })
        .success,
    ).toBe(false);
    expect(
      ok({ operation: "merge", entity: "banana", mergeIds: ["PRD-2CRC"] })
        .success,
    ).toBe(false);
  });
});

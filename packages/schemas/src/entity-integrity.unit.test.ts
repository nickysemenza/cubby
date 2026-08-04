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
  describe("delete", () => {
    it("accepts ids matching the entity", () => {
      expect(
        ok({ operation: "delete", entity: "product", ids: ["PRD-2CRC"] })
          .success,
      ).toBe(true);
    });

    it("requires ids", () => {
      expect(errorPaths({ operation: "delete", entity: "product" })).toContain(
        "ids",
      );
    });

    it("rejects merge-only fields", () => {
      expect(
        errorPaths({
          operation: "delete",
          entity: "product",
          ids: ["PRD-2CRC"],
          mergeIds: ["PRD-2CRD"],
          keepId: "PRD-2CRE",
        }),
      ).toEqual(expect.arrayContaining(["mergeIds", "keepId"]));
    });

    it("rejects an id whose prefix names a different entity", () => {
      // The check the flattening most easily could have dropped: the old union
      // pinned the id schema per member, so a LOC- code simply matched no arm.
      expect(
        errorPaths({
          operation: "delete",
          entity: "product",
          ids: ["LOC-2CRC"],
        }),
      ).toContain("ids.0");
    });

    it("takes a uuid for image, the one entity with no shortcode", () => {
      expect(
        ok({
          operation: "delete",
          entity: "image",
          ids: ["3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
        }).success,
      ).toBe(true);
      expect(
        errorPaths({ operation: "delete", entity: "image", ids: ["PRD-2CRC"] }),
      ).toContain("ids.0");
    });

    it("normalizes casing and surrounding whitespace", () => {
      const parsed = ok({
        operation: "delete",
        entity: "product",
        ids: [" prd-2crc "],
      });
      expect(parsed.success && parsed.data.ids).toEqual(["PRD-2CRC"]);
    });
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

    it("rejects the delete-only ids field", () => {
      expect(
        errorPaths({
          operation: "merge",
          entity: "ingredient",
          mergeIds: ["ING-2CRC"],
          ids: ["ING-2CRD"],
        }),
      ).toContain("ids");
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

  it("rejects an unknown operation or entity outright", () => {
    expect(
      ok({ operation: "archive", entity: "product", ids: ["PRD-2CRC"] })
        .success,
    ).toBe(false);
    expect(
      ok({ operation: "delete", entity: "banana", ids: ["PRD-2CRC"] }).success,
    ).toBe(false);
  });
});

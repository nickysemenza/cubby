import { describe, expect, it } from "vitest";
import { z } from "zod";
import { previewOperationInputSchema } from "./entity-integrity";

type RejectedPreviewInput =
  | {
      operation: "merge";
      entity: "product";
      keepId: string;
      mergeIds: string[];
    }
  | { operation: "delete"; entity: "product"; ids: string[] };
type PreviewFixture =
  | z.input<typeof previewOperationInputSchema>
  | RejectedPreviewInput;

const parse = (input: PreviewFixture) =>
  previewOperationInputSchema.safeParse(input);
const errorPaths = (input: PreviewFixture): string[] => {
  const result = parse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
};

describe("previewOperationInputSchema", () => {
  it("accepts attach and detach for every supported relation family", () => {
    for (const [entity, parentId] of [
      ["product", "PRD-2CRC"],
      ["project", "PRJ-2CRC"],
      ["purchase", "PUR-2CRC"],
    ] as const) {
      for (const operation of ["attach", "detach"] as const) {
        expect(
          parse({ operation, entity, parentId, productIds: ["PRD-2CRD"] })
            .success,
          `${operation} ${entity}`,
        ).toBe(true);
      }
    }
  });

  it("requires a matching parent shortcode and distinct products", () => {
    expect(
      errorPaths({
        operation: "attach",
        entity: "project",
        parentId: "PUR-2CRC",
        productIds: ["PRD-2CRD"],
      }),
    ).toContain("parentId");
    expect(
      errorPaths({
        operation: "detach",
        entity: "product",
        parentId: "PRD-2CRC",
        productIds: ["PRD-2CRD", "PRD-2CRD"],
      }),
    ).toContain("productIds");
  });

  it("rejects merge and delete previews", () => {
    expect(
      parse({
        operation: "merge",
        entity: "product",
        keepId: "PRD-2CRC",
        mergeIds: ["PRD-2CRD"],
      }).success,
    ).toBe(false);
    expect(
      parse({ operation: "delete", entity: "product", ids: ["PRD-2CRC"] })
        .success,
    ).toBe(false);
  });
});

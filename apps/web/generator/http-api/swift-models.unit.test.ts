import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  ContractMember,
  LoadedContract,
} from "../start-operations/collect.ts";
import { collectNativeContract } from "./native-contract.ts";
import { renderSwiftModels } from "./swift-models.ts";

const render = (output: z.ZodType) => {
  const contract: LoadedContract[] = [
    {
      exportName: "exampleContract",
      module: "~/contracts/example",
      contract: {
        domain: "example",
        ops: {
          read: {
            kind: "query",
            input: z.undefined(),
            output,
          } satisfies ContractMember,
        },
      },
    },
  ];
  return renderSwiftModels(collectNativeContract(contract));
};

describe("native model generation guards", () => {
  it("rejects enum values whose Swift case names would collide", () => {
    expect(() => render(z.enum(["future-state", "future_state"]))).toThrow(
      /enum case collision/u,
    );
  });

  it("refuses incompatible structural names instead of reusing the first codec", () => {
    expect(() =>
      render(
        z.object({
          foo: z.object({ bar: z.object({ a: z.string() }) }),
          fooBar: z.object({ b: z.number() }),
        }),
      ),
    ).toThrow(/structural model name collision/u);
  });

  it("keeps a shared nested discriminator value as one semantic case", () => {
    const completed = z.union([
      z.object({ status: z.literal("completed"), kind: z.literal("first") }),
      z.object({ status: z.literal("completed"), kind: z.literal("second") }),
    ]);
    const source = render(
      z.union([completed, z.object({ status: z.literal("failed") })]),
    )
      .artifacts.map((artifact) => artifact.source)
      .join("\n");
    expect(source).toContain("case `completed`(");
    expect(source).toContain("case `failed`(");
  });

  it("preserves presence when a nullable field refers to a named alias", () => {
    const source = renderSwiftModels({
      operations: [],
      records: ["output/Example"],
      models: {
        "output/MaybeText": { anyOf: [{ type: "string" }, { type: "null" }] },
        "output/Example": {
          type: "object",
          properties: { value: { $ref: "native://output/MaybeText" } },
        },
      },
    })
      .artifacts.map((artifact) => artifact.source)
      .join("\n");
    expect(source).toContain("public var `value`: NativeField<MaybeText>");
    expect(source).toContain("`value`: NativeField<MaybeText> = .absent");
    expect(source).toContain("container.decode(MaybeText.self");
  });

  it("generates fixed tuple models that preserve the array wire shape", () => {
    const source = render(z.tuple([z.string(), z.number()]))
      .artifacts.map((artifact) => artifact.source)
      .join("\n");

    expect(source).toContain("public struct ExampleReadOutput");
    expect(source).toContain("public var `element1`: String");
    expect(source).toContain("public var `element2`: Double");
    expect(source).toContain("unkeyedContainer()");
    expect(source).toContain("Expected exactly 2 tuple elements");
  });

  it("generates tuple rest values as trailing array elements", () => {
    const source = render(z.tuple([z.string()]).rest(z.number()))
      .artifacts.map((artifact) => artifact.source)
      .join("\n");

    expect(source).toContain("public var `element1`: String");
    expect(source).toContain("public var `rest`: [Double]");
    expect(source).toContain("while !container.isAtEnd");
  });
});

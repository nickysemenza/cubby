import { initContract } from "@ts-rest/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { collectNativeContract } from "./native-contract.ts";

const contract = initContract();
const error = z.object({ code: z.string(), message: z.string() });
const update = z.object({
  optional: z.string().optional(),
  nullable: z.string().nullable(),
  optionalNullable: z.string().nullable().optional(),
});
const result = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), value: z.string() }),
  z.object({ kind: z.literal("waiting"), reason: z.string() }),
]);
const router = contract.router({
  update: {
    method: "POST",
    path: "/api/v1/example/update",
    body: update,
    responses: { 200: result, 400: error, 500: error },
    metadata: { operation: "example.update", input: "object" },
  },
});

describe("direct native contract", () => {
  it("retains omitted versus nullable fields before Swift codec generation", () => {
    const native = collectNativeContract(router);
    const operation = native.operations[0]!;
    expect(operation).toMatchObject({
      id: "example.update",
      method: "POST",
      path: "/api/v1/example/update",
      body: "input/ExampleUpdateInput",
    });
    const model = native.models[operation.body!];
    expect(model?.required).toEqual(["nullable"]);
    expect(model?.properties?.nullable).toMatchObject({
      type: ["string", "null"],
    });
    expect(model?.properties?.optionalNullable).toMatchObject({
      type: ["string", "null"],
    });
  });

  it("retains the discriminant and variants rather than normalizing away union semantics", () => {
    const native = collectNativeContract(router);
    expect(native.models[native.operations[0]!.output]).toMatchObject({
      "x-native-discriminator": "kind",
      oneOf: [
        { properties: { kind: { const: "ready" }, value: { type: "string" } } },
        {
          properties: {
            kind: { const: "waiting" },
            reason: { type: "string" },
          },
        },
      ],
    });
  });

  it("refuses a divergent later error status", () => {
    expect(() =>
      collectNativeContract(
        contract.router({
          update: {
            ...router.update,
            responses: {
              200: result,
              400: error,
              500: z.object({ other: z.string() }),
            },
          },
        }),
      ),
    ).toThrow(/error status 500 differs/u);
  });
});

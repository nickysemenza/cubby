import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ContractMember, LoadedContract } from "../operations/collect.ts";
import { collectNativeContract } from "./native-contract.ts";

const contract = (
  domain: string,
  ops: Record<string, ContractMember>,
): LoadedContract[] => [
  {
    exportName: `${domain}Contract`,
    module: `~/contracts/${domain}`,
    contract: { domain, ops },
  },
];

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

describe("operation contract wire collection", () => {
  it("names shared values reached only through native record envelopes", () => {
    const summary = z.object({ count: z.number() });
    const record = z.object({
      fields: z.object({ summary: z.object({ value: summary }) }),
    });
    const native = collectNativeContract(
      [],
      new Map([["SyntheticRecord", record]]),
      new Map([["SyntheticSummary", summary]]),
    );
    expect(native.models["output/SyntheticSummary"]).toMatchObject({
      properties: { count: { type: "number" } },
    });
    expect(
      native.models["output/SyntheticRecord"]?.properties?.fields,
    ).toMatchObject({
      properties: {
        summary: {
          properties: { value: { $ref: "native://output/SyntheticSummary" } },
        },
      },
    });
  });

  it("retains omitted versus nullable fields before Swift codec generation", () => {
    const native = collectNativeContract(
      contract("example", {
        update: { kind: "mutation", input: update, output: result },
      }),
    );
    const operation = native.operations[0]!;
    expect(operation).toMatchObject({
      id: "example.update",
      input: "body",
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

  it("retains discriminated union variants and nullable operation outputs", () => {
    const native = collectNativeContract(
      contract("example", {
        read: {
          kind: "query",
          input: z.undefined(),
          output: result.nullable(),
        },
      }),
    );
    const operation = native.operations[0]!;
    expect(operation.input).toBe("none");
    expect(native.models[operation.output]).toMatchObject({
      anyOf: [
        {
          "x-native-discriminator": "kind",
          oneOf: [
            {
              properties: {
                kind: { const: "ready" },
                value: { type: "string" },
              },
            },
            {
              properties: {
                kind: { const: "waiting" },
                reason: { type: "string" },
              },
            },
          ],
        },
        { type: "null" },
      ],
    });
  });

  it("reports unsupported shapes with the operation identity", () => {
    expect(() =>
      collectNativeContract(
        contract("example", {
          read: {
            kind: "query",
            input: z.undefined(),
            output: z.custom<Date>(),
          },
        }),
      ),
    ).toThrow(/example\.read: unsupported output wire shape/u);
  });

  it("keeps null as an input value and every query or mutation in the catalog", () => {
    const native = collectNativeContract(
      contract("example", {
        nullQuery: { kind: "query", input: z.null(), output: z.number() },
        write: {
          kind: "mutation",
          input: z.object({ value: z.string() }),
          output: error,
        },
        stream: {
          kind: "subscription",
          input: z.undefined(),
          event: z.string(),
        },
      }),
    );
    expect(native.operations.map(({ id }) => id)).toEqual([
      "example.nullQuery",
      "example.write",
    ]);
    expect(native.operations[0]).toMatchObject({
      id: "example.nullQuery",
      input: "null",
    });
  });

  it("does not project members excluded from the HTTP operation catalog", () => {
    const native = collectNativeContract(
      contract("example", {
        publicRead: {
          kind: "query",
          input: z.undefined(),
          output: z.string(),
        },
        internalRead: {
          kind: "query",
          input: z.undefined(),
          output: z.custom<Date>(),
        },
      }),
      new Map(),
      new Map(),
      ["example.publicRead"],
    );

    expect(native.operations.map(({ id }) => id)).toEqual([
      "example.publicRead",
    ]);
  });
});

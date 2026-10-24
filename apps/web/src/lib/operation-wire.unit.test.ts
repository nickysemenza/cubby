import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as contracts from "~/contracts/index";
import { mock } from "~/lib/test/mock-schema";

import {
  type Json,
  toWire,
  WireSchemaError,
  wireRegistry,
} from "./operation-wire";

interface WireCase {
  name: string;
  io: "input" | "output";
  schema: z.ZodType;
}

/**
 * Every query and mutation schema carried over the shared operation route,
 * once per identity.
 */
const cases = (() => {
  const seen = new Map<z.ZodType, WireCase>();
  for (const contract of Object.values(contracts)) {
    for (const [member, operation] of Object.entries(contract.ops)) {
      if (operation.kind === "subscription") continue;
      const name = `${contract.domain}.${member}`;
      const input = operation.operationWire?.input ?? operation.input;
      const output = operation.operationWire?.output ?? operation.output;
      const inputSchema =
        operation.nativeModels?.input === "json" ? z.json() : input;
      let outputSchema =
        operation.nativeModels?.output === "json" ? z.json() : output;
      if (operation.operationWire?.nullable)
        outputSchema = outputSchema.nullable();
      if (!seen.has(inputSchema) && !(inputSchema instanceof z.ZodUndefined))
        seen.set(inputSchema, {
          name: `${name} input`,
          io: "input",
          schema: inputSchema,
        });
      if (!seen.has(outputSchema))
        seen.set(outputSchema, {
          name: `${name} output`,
          io: "output",
          schema: outputSchema,
        });
    }
  }
  return [...seen.values()];
})();

const roundTrip = <T>(value: T): Json<T> => JSON.parse(JSON.stringify(value));

/**
 * `mock()` only guarantees a parse-valid value when optionals are omitted;
 * filling them exercises more Date leaves but can trip refinements, so prefer
 * the fuller sample and fall back to the guaranteed one. Schemas whose
 * cross-field refinements no generated value satisfies are reported as
 * unmockable rather than failing: the walker is still exercised on them.
 */
const sampleFor = <S extends z.ZodType>(schema: S): z.infer<S> | undefined => {
  for (const fillOptionals of [true, false]) {
    try {
      return mock(schema, { seed: 1, fillOptionals });
    } catch {
      // try the next strategy
    }
  }
  return undefined;
};

const sampled = cases.map((entry) => ({
  ...entry,
  sample: sampleFor(entry.schema),
}));
const mockable = sampled.filter((entry) => entry.sample !== undefined);
const unmockable = sampled.filter((entry) => entry.sample === undefined);

describe("toWire parity with the JSON wire", () => {
  it("covers the contract and most schemas are mockable", () => {
    expect(cases.length).toBeGreaterThan(100);
    expect(cases.some((entry) => entry.io === "output")).toBe(true);
    expect(cases.some((entry) => entry.io === "input")).toBe(true);
    // Refinement-heavy schemas cannot be sampled generically; keep the
    // unsampled share small so the round trip stays representative.
    expect(
      unmockable
        .map((entry) => entry.name)
        .filter(() => unmockable.length > cases.length / 4),
    ).toEqual([]);
  });

  it.each(cases)("builds a wire schema: $name", ({ schema, io }) => {
    expect(toWire(schema, io)).toBeInstanceOf(z.ZodType);
  });

  it.each(mockable.filter((entry) => entry.io === "output"))(
    "output survives JSON: $name",
    ({ schema, sample }) => {
      const wire = toWire(schema, "output");
      const parsed = wire.safeParse(roundTrip(schema.parse(sample)));
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.success).toBe(true);
    },
  );

  it.each(mockable.filter((entry) => entry.io === "input"))(
    "input round-trips into the domain schema: $name",
    ({ schema, sample }) => {
      const wire = toWire(schema, "input");
      const onWire = wire.safeParse(roundTrip(sample));
      expect(onWire.error?.issues ?? []).toEqual([]);
      expect(onWire.success).toBe(true);
      const domain = schema.safeParse(onWire.data);
      expect(domain.error?.issues ?? []).toEqual([]);
      expect(domain.success).toBe(true);
    },
  );
});
describe("toWire mapping rules", () => {
  it("maps output Dates to ISO strings and rejects other strings", () => {
    const domain = z.object({ at: z.date(), maybe: z.date().nullable() });
    const wire = toWire(domain, "output");
    expect(
      wire.safeParse({ at: new Date(0).toISOString(), maybe: null }).success,
    ).toBe(true);
    expect(wire.safeParse({ at: "nope", maybe: null }).success).toBe(false);
    expect(wire.safeParse({ at: new Date(0), maybe: null }).success).toBe(
      false,
    );
  });

  it("requires coerced dates on inputs", () => {
    expect(() => toWire(z.object({ at: z.date() }), "input")).toThrow(
      WireSchemaError,
    );
    const wire = toWire(z.object({ at: z.coerce.date() }), "input");
    expect(wire.safeParse({ at: new Date(0).toISOString() }).success).toBe(
      true,
    );
  });

  it("keeps refinements, defaults and descriptions", () => {
    const domain = z
      .object({
        start: z.date(),
        end: z.date(),
        label: z.string().default("x").describe("Label"),
      })
      .refine((value) => value.end >= value.start, { path: ["end"] });
    const wire = toWire(domain, "output");
    const early = new Date(0).toISOString();
    const late = new Date(1).toISOString();
    expect(
      wire.safeParse({ start: early, end: late, label: "y" }).success,
    ).toBe(true);
    expect(
      wire.safeParse({ start: late, end: early, label: "y" }).success,
    ).toBe(false);
    // Outputs already carry defaults, so the wire requires the field.
    expect(wire.safeParse({ start: early, end: late }).success).toBe(false);
    expect(wire).toBeInstanceOf(z.ZodObject);
    const wireFields = wire instanceof z.ZodObject ? wire.shape : {};
    expect(wireFields.label?.description).toBe("Label");
  });

  it("rebuilds discriminated unions and lazy schemas", () => {
    const leaf = z.object({ kind: z.literal("leaf"), at: z.date() });
    interface Tree {
      kind: "node";
      children: (Tree | { kind: "leaf"; at: Date })[];
    }
    const tree: z.ZodType<Tree> = z.lazy(() =>
      z.object({
        kind: z.literal("node"),
        children: z.array(z.discriminatedUnion("kind", [leaf, tree as never])),
      }),
    );
    const wire = toWire(tree, "output");
    const sample = {
      kind: "node",
      children: [
        { kind: "leaf", at: new Date(0).toISOString() },
        { kind: "node", children: [] },
      ],
    };
    expect(wire.safeParse(sample).success).toBe(true);
    expect(
      wire.safeParse({ kind: "node", children: [{ kind: "leaf", at: 1 }] })
        .success,
    ).toBe(false);
  });

  it("memoises per schema and io and names registered schemas", () => {
    const domain = z.object({ at: z.coerce.date() }).meta({ id: "Stamp" });
    expect(toWire(domain, "output")).toBe(toWire(domain, "output"));
    expect(toWire(domain, "output")).not.toBe(toWire(domain, "input"));
    expect(wireRegistry.get(toWire(domain, "output"))?.id).toBe("output_Stamp");
  });

  it("rejects shapes JSON cannot carry", () => {
    for (const schema of [
      z.object({ s: z.set(z.string()) }),
      z.object({ m: z.map(z.string(), z.number()) }),
      z.object({ b: z.bigint() }),
      z.object({ c: z.custom<string>() }),
      z.object({ t: z.string().transform((value) => value.length) }),
    ]) {
      expect(() => toWire(schema, "output")).toThrow(WireSchemaError);
    }
  });

  it("uses the input side of pipes for inputs and the output side for outputs", () => {
    const codec = z.object({
      n: z
        .string()
        .transform((value) => Number(value))
        .pipe(z.number()),
    });
    expect(toWire(codec, "input").safeParse({ n: "1" }).success).toBe(true);
    expect(toWire(codec, "output").safeParse({ n: 1 }).success).toBe(true);
    expect(toWire(codec, "output").safeParse({ n: "1" }).success).toBe(false);
  });
});

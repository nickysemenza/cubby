import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as contracts from "~/contracts/index";
import { mock } from "~/lib/test/mock-schema";

import {
  isFlatQueryInput,
  type Json,
  QueryProjectionError,
  toWire,
  WireSchemaError,
  wireRegistry,
} from "./wire";

interface WireCase {
  name: string;
  io: "input" | "output";
  schema: z.ZodType;
}

/**
 * Every schema the HTTP contract carries, once per identity: each HTTP-exposed
 * contract member's input and output.
 */
const cases = (() => {
  const seen = new Map<z.ZodType, WireCase>();
  for (const contract of Object.values(contracts)) {
    for (const [member, operation] of Object.entries(contract.ops)) {
      if (operation.kind === "subscription" || operation.http === false)
        continue;
      const name = `${contract.domain}.${member}`;
      const { input, output } = operation;
      if (!seen.has(input) && !(input instanceof z.ZodUndefined))
        seen.set(input, { name: `${name} input`, io: "input", schema: input });
      if (!seen.has(output))
        seen.set(output, {
          name: `${name} output`,
          io: "output",
          schema: output,
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
    // SAFETY: `tree` is referenced inside its own lazy getter; the recursive
    // type is declared explicitly on the binding so the cast only breaks the
    // inference cycle Zod cannot resolve on its own.
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

const isQueryObject = (
  value: Json<unknown>,
): value is Record<string, Json<unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** What a client puts on the URL: text per value, one key per list element. */
const renderQuery = (value: Json<unknown>): URLSearchParams => {
  const search = new URLSearchParams();
  if (!isQueryObject(value)) return search;
  for (const [key, entry] of Object.entries(value)) {
    for (const item of Array.isArray(entry) ? entry : [entry]) {
      if (item === undefined || item === null) continue;
      search.append(key, String(item));
    }
  }
  return search;
};

/** What the router hands the route: a string per key, an array for repeats. */
const asRouterQuery = (search: URLSearchParams) => {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    const [single] = values;
    query[key] = values.length === 1 && single !== undefined ? single : values;
  }
  return query;
};

/**
 * Every `query` operation whose object input travels as GET parameters. The
 * query projection normalises one-or-many filters to a list, so a bare value
 * in the sample is equivalent to the one-element list that comes back.
 */
const flatQueries = Object.values(contracts).flatMap((contract) =>
  Object.entries(contract.ops).flatMap(([member, operation]) => {
    if (operation.kind !== "query" || operation.http === false) return [];
    const { input } = operation;
    if (!(input instanceof z.ZodObject)) return [];
    if (!isFlatQueryInput(toWire(input, "input"))) return [];
    const sample = sampleFor(input);
    return sample === undefined
      ? []
      : [{ name: `${contract.domain}.${member}`, schema: input, sample }];
  }),
);

const asList = (value: Json<unknown>) =>
  Array.isArray(value) ? value : [value];

const equivalentQueryValues = (
  received: Json<unknown>,
  expected: Json<unknown>,
): boolean =>
  isQueryObject(received) && isQueryObject(expected)
    ? Object.keys({ ...received, ...expected }).every((key) => {
        const [want, got] = [expected[key], received[key]];
        if (want === undefined || want === null)
          return got === undefined || got === null;
        return (
          JSON.stringify(asList(got ?? [])) === JSON.stringify(asList(want))
        );
      })
    : JSON.stringify(received) === JSON.stringify(expected);

describe("toWire query projection", () => {
  it("covers the flat query inputs", () => {
    expect(flatQueries.length).toBeGreaterThan(20);
  });

  it.each(flatQueries)("query round-trips: $name", ({ schema, sample }) => {
    const rendered = asRouterQuery(renderQuery(roundTrip(sample)));
    const onWire = toWire(schema, "query").safeParse(rendered);
    expect(onWire.error?.issues ?? []).toEqual([]);
    const domain = schema.safeParse(onWire.data);
    expect(domain.error?.issues ?? []).toEqual([]);
    expect(
      equivalentQueryValues(
        roundTrip(domain.data),
        roundTrip(schema.parse(sample)),
      ),
    ).toBe(true);
  });

  it("coerces literal numbers and booleans", () => {
    const wire = toWire(
      z.object({
        days: z.union([z.literal(7), z.literal(30)]),
        on: z.literal(true),
      }),
      "query",
    );
    expect(wire.parse({ days: "30", on: "true" })).toEqual({
      days: 30,
      on: true,
    });
    expect(wire.safeParse({ days: "8", on: "true" }).success).toBe(false);
  });

  it("coerces numbers and keeps their checks", () => {
    const wire = toWire(z.object({ page: z.number().int().min(1) }), "query");
    expect(wire.parse({ page: "12" })).toEqual({ page: 12 });
    expect(wire.parse({ page: 12 })).toEqual({ page: 12 });
    expect(wire.safeParse({ page: "0" }).success).toBe(false);
    expect(wire.safeParse({ page: "x" }).success).toBe(false);
  });

  it("reads booleans from their text form", () => {
    const wire = toWire(z.object({ live: z.boolean() }), "query");
    expect(wire.parse({ live: "false" })).toEqual({ live: false });
    expect(wire.parse({ live: "true" })).toEqual({ live: true });
    expect(wire.parse({ live: true })).toEqual({ live: true });
    expect(wire.safeParse({ live: "yes" }).success).toBe(false);
  });

  it("carries lists as repeated keys and accepts a single value", () => {
    const wire = toWire(z.object({ tag: z.array(z.string()) }), "query");
    expect(wire.parse({ tag: "a" })).toEqual({ tag: ["a"] });
    expect(wire.parse({ tag: ["a", "b"] })).toEqual({ tag: ["a", "b"] });
  });

  it("collapses the one-or-many union onto one list parameter", () => {
    const status = z.enum(["open", "done"]);
    const domain = z.object({
      status: z.union([status, z.array(status)]).optional(),
    });
    const wire = toWire(domain, "query");
    expect(wire.parse({ status: "open" })).toEqual({ status: ["open"] });
    expect(wire.parse({})).toEqual({});
    expect(
      z.toJSONSchema(wire, { io: "output", target: "draft-2020-12" }),
    ).toMatchObject({
      properties: {
        status: { type: "array", items: { enum: ["open", "done"] } },
      },
    });
  });

  it("turns nullable and defaulted fields into optionals", () => {
    const wire = toWire(
      z.object({ note: z.string().nullable(), size: z.number().default(3) }),
      "query",
    );
    expect(wire.parse({})).toEqual({});
    expect(wire.parse({ note: "x", size: "4" })).toEqual({
      note: "x",
      size: 4,
    });
  });

  it("rejects unknown keys and nested objects", () => {
    expect(
      toWire(z.object({ a: z.string() }), "query").safeParse({ a: "x", b: "y" })
        .success,
    ).toBe(false);
    expect(() =>
      toWire(z.object({ scope: z.object({ a: z.string() }) }), "query"),
    ).toThrow(QueryProjectionError);
    expect(() =>
      toWire(z.object({ rows: z.array(z.object({ a: z.string() })) }), "query"),
    ).toThrow(/at rows/u);
    expect(() =>
      toWire(z.object({ map: z.record(z.string(), z.string()) }), "query"),
    ).toThrow(QueryProjectionError);
  });

  it("decides flatness on the input wire", () => {
    const flat = z.object({
      q: z.string(),
      page: z.number(),
      tags: z.array(z.string()).optional(),
      from: z.coerce.date().optional(),
    });
    expect(isFlatQueryInput(toWire(flat, "input"))).toBe(true);
    expect(isFlatQueryInput(z.null())).toBe(true);
    expect(isFlatQueryInput(z.string())).toBe(true);
    expect(
      isFlatQueryInput(
        toWire(z.object({ scope: z.object({ a: z.string() }) }), "input"),
      ),
    ).toBe(false);
    expect(
      isFlatQueryInput(toWire(z.object({ a: z.string() }).optional(), "input")),
    ).toBe(false);
    expect(
      isFlatQueryInput(
        toWire(z.union([z.object({ a: z.string() }), z.object({})]), "input"),
      ),
    ).toBe(false);
  });

  it("memoises per io", () => {
    const domain = z.object({ n: z.number() });
    expect(toWire(domain, "query")).toBe(toWire(domain, "query"));
    expect(toWire(domain, "query")).not.toBe(toWire(domain, "input"));
  });
});

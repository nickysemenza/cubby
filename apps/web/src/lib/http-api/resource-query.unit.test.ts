import { encodeQueryParamsJson, parseJsonQueryObject } from "@ts-rest/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { resourceListInputFrom, resourceListQuery } from "./resource-query";

const schema = resourceListQuery(
  z.object({
    nameFilter: z.string().optional(),
    nullableName: z.string().nullable().optional(),
    active: z.boolean().optional(),
    minimum: z.number().optional(),
    tags: z.array(z.string()).optional(),
    range: z.object({ min: z.number(), max: z.number() }).optional(),
  }),
);
/** What the server sees: ts-rest's jsonQuery decoding, then the wire schema. */
const decode = (query: string) =>
  resourceListInputFrom(
    schema.parse(
      parseJsonQueryObject(Object.fromEntries(new URLSearchParams(query))),
    ),
  );

describe("resource list query", () => {
  it("maps 1-based pages and a sort stack to existing list inputs", () => {
    expect(
      decode(
        "page=2&pageSize=25&sort=name,-createdAt&groupBy=category&nameFilter=soup",
      ),
    ).toEqual({
      filters: { nameFilter: "soup" },
      pagination: { pageIndex: 1, pageSize: 25 },
      sort: [
        { orderBy: "name", direction: "asc" },
        { orderBy: "createdAt", direction: "desc" },
      ],
      groupBy: "category",
    });
    expect(decode("pageSize=2")).toEqual({
      filters: {},
      pagination: { pageIndex: 0, pageSize: 2 },
    });
    expect(decode("page=2")).toEqual({
      filters: {},
      pagination: { pageIndex: 1, pageSize: 10 },
    });
    expect(decode("")).toEqual({ filters: {} });
  });
  it("decodes booleans, numbers, and JSON values using their schemas", () => {
    expect(
      decode(
        new URLSearchParams({
          active: "false",
          minimum: "12",
          tags: '["a","b"]',
          range: '{"min":1,"max":5}',
        }).toString(),
      ),
    ).toEqual({
      filters: {
        active: false,
        minimum: 12,
        tags: ["a", "b"],
        range: { min: 1, max: 5 },
      },
    });
  });
  it.each(["123", "001", "true", "false", "null", "a&b+c"])(
    "round-trips literal text %s through the typed client encoding",
    (text) => {
      // The client quotes numeric/boolean/null-looking strings, so the server
      // reads them back as the same text; a hand-typed URL must quote them
      // the same way.
      const query = encodeQueryParamsJson({ nameFilter: text });
      expect(decode(query)).toEqual({ filters: { nameFilter: text } });
    },
  );
  it("reads array- and object-looking text as JSON unless it is quoted", () => {
    // ts-rest's jsonQuery only quotes scalars; a string like "[1,2]" must be
    // quoted by the caller to stay text, otherwise it decodes as JSON and fails
    // the string filter.
    expect(() => decode("nameFilter=%5B1%2C2%5D")).toThrow(/./u);
    expect(decode("nameFilter=%22%5B1%2C2%5D%22")).toEqual({
      filters: { nameFilter: "[1,2]" },
    });
  });
  it("preserves JSON null and quoted strings for nullable filters", () => {
    expect(decode("nullableName=null")).toEqual({
      filters: { nullableName: null },
    });
    expect(decode("nullableName=%22null%22")).toEqual({
      filters: { nullableName: "null" },
    });
  });
  it.each([
    "page=0",
    "page=-1",
    "page=1.5",
    "page=no",
    "pageSize=0",
    "pageSize=501",
    "sort=",
    "sort=-",
    "sort=name,",
    "sort=a,b,c,d",
    "active=maybe",
    "minimum=no",
    "range=bad",
    "unknown=1",
    "pagination={}",
    "filters={}",
  ])("rejects malformed query %s", (query) => {
    expect(() => decode(query)).toThrow(/./u);
  });
  it("rejects filter names colliding with resource controls", () => {
    expect(() => resourceListQuery(z.object({ page: z.number() }))).toThrow(
      "collision",
    );
  });
});

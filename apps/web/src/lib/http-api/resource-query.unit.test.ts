import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  resourceListQuerySchema,
  decodeResourceListQuery,
} from "./resource-query";

const schema = resourceListQuerySchema(
  z.object({
    nameFilter: z.string().optional(),
    nullableName: z.string().nullable().optional(),
    active: z.boolean().optional(),
    minimum: z.number().optional(),
    tags: z.array(z.string()).optional(),
    range: z.object({ min: z.number(), max: z.number() }).optional(),
  }),
);
const decode = (query: string) =>
  decodeResourceListQuery(new URLSearchParams(query), schema);

describe("resource query parameters", () => {
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
  it.each([
    "123",
    "001",
    "true",
    "false",
    "null",
    '"quoted"',
    "[1,2]",
    "a&b+c",
  ])("preserves literal text %s", (text) => {
    expect(
      decode(new URLSearchParams({ nameFilter: text }).toString()),
    ).toEqual({ filters: { nameFilter: text } });
  });
  it("decodes booleans, numbers, and JSON-valued filters using their schemas", () => {
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
    "page=1&page=2",
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
    expect(() =>
      resourceListQuerySchema(z.object({ page: z.number() })),
    ).toThrow("collision");
  });
});

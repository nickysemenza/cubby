import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  groupableFieldsOf,
  resourceListInputFrom,
  resourceListQuery,
  resourceQueryNesting,
} from "./resource-query";

const schema = resourceListQuery(
  z.object({
    nameFilter: z.string().optional(),
    nullableName: z.string().nullable().optional(),
    active: z.boolean().optional(),
    minimum: z.number().optional(),
    tags: z.array(z.string()).optional(),
    scope: z
      .object({
        statuses: z.array(z.enum(["open", "done"])).optional(),
        search: z.string().optional(),
        year: z
          .string()
          .regex(/^\d{4}$/u)
          .optional(),
      })
      .optional(),
  }),
);

/** What the router hands the route: a string per key, an array for repeats. */
const asRouterQuery = (query: string) => {
  const search = new URLSearchParams(query);
  const values: Record<string, string | string[]> = {};
  for (const key of new Set(search.keys())) {
    const all = search.getAll(key);
    const [single] = all;
    values[key] = all.length === 1 && single !== undefined ? single : all;
  }
  return values;
};

/** What the server sees: the wire schema over the router's query object. */
const decode = (query: string) =>
  resourceListInputFrom(
    schema.parse(asRouterQuery(query)),
    resourceQueryNesting(schema),
  );

describe("resource list query", () => {
  it("maps 1-based pages and a sort stack to existing list inputs", () => {
    expect(
      decode(
        "page=2&pageSize=25&sort=name,-createdAt&groupBy=categoryId&nameFilter=soup",
      ),
    ).toEqual({
      filters: { nameFilter: "soup" },
      pagination: { pageIndex: 1, pageSize: 25 },
      sort: [
        { orderBy: "name", direction: "asc" },
        { orderBy: "createdAt", direction: "desc" },
      ],
      groupBy: "categoryId",
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

  it("reads booleans, numbers and repeated keys from their text form", () => {
    expect(decode("active=false&minimum=12&tags=a&tags=b")).toEqual({
      filters: { active: false, minimum: 12, tags: ["a", "b"] },
    });
    expect(decode("tags=only")).toEqual({ filters: { tags: ["only"] } });
  });

  it("flattens an object filter onto prefixed parameters and re-nests it", () => {
    expect(resourceQueryNesting(schema).get("scopeStatuses")).toEqual([
      "scope",
      "statuses",
    ]);
    expect(
      decode("scopeStatuses=open&scopeStatuses=done&scopeSearch=deck"),
    ).toEqual({
      filters: { scope: { statuses: ["open", "done"], search: "deck" } },
    });
    expect(decode("scopeYear=2026")).toEqual({
      filters: { scope: { year: "2026" } },
    });
  });

  it.each(["123", "001", "true", "false", "null", "[1,2]", "a&b+c"])(
    "keeps text literal: %s",
    (text) => {
      const query = new URLSearchParams({ nameFilter: text }).toString();
      expect(decode(query)).toEqual({ filters: { nameFilter: text } });
    },
  );

  it("treats a nullable filter as optional text", () => {
    expect(decode("nullableName=null")).toEqual({
      filters: { nullableName: "null" },
    });
    expect(decode("")).toEqual({ filters: {} });
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
    "scopeStatuses=nope",
    "scopeYear=26",
    "scope=bad",
    "unknown=1",
    "pagination={}",
    "filters={}",
  ])("rejects malformed query %s", (query) => {
    expect(() => decode(query)).toThrow(/./u);
  });

  it("rejects filter names colliding with resource controls or each other", () => {
    expect(() => resourceListQuery(z.object({ page: z.number() }))).toThrow(
      "collision",
    );
    expect(() =>
      resourceListQuery(
        z.object({
          scopeSearch: z.string().optional(),
          scope: z.object({ search: z.string().optional() }).optional(),
        }),
      ),
    ).toThrow("collision");
    expect(() =>
      resourceListQuery(
        z.object({
          scope: z.object({ inner: z.object({ a: z.string() }) }).optional(),
        }),
      ),
    ).toThrow("too deep");
  });

  describe("with an entity sort roster", () => {
    const roster = {
      fields: ["name", "createdAt", "categoryId"],
      default: "createdAt",
      groupable: ["categoryId"],
    } as const;
    const rostered = resourceListQuery(
      z.object({ nameFilter: z.string().optional() }),
      roster,
    );
    const issuesOf = (query: string) =>
      rostered.safeParse(asRouterQuery(query)).error?.issues ?? [];

    it("accepts sortable fields in either direction and a groupable field", () => {
      expect(
        rostered.parse(
          asRouterQuery("sort=name,-createdAt&groupBy=categoryId"),
        ),
      ).toEqual({ sort: "name,-createdAt", groupBy: "categoryId" });
    });

    it("rejects an unsupported sort field by name on the sort path", () => {
      expect(issuesOf("sort=bogus")).toEqual([
        expect.objectContaining({
          path: ["sort"],
          message:
            'Unsupported sort field "bogus"; expected one of name, createdAt, categoryId',
        }),
      ]);
      expect(issuesOf("sort=name,bogus")).toEqual([
        expect.objectContaining({
          path: ["sort"],
          message: expect.stringContaining('Unsupported sort field "bogus"'),
        }),
      ]);
      // A malformed stack reports its shape once, not a field per fragment.
      expect(issuesOf("sort=")).toHaveLength(1);
    });

    it("rejects a sortable field that is not groupable", () => {
      expect(issuesOf("groupBy=name")).toEqual([
        expect.objectContaining({ path: ["groupBy"] }),
      ]);
    });

    it("treats an empty groupable set as every sortable field, like the kernel", () => {
      const open = { ...roster, groupable: [] };
      expect(groupableFieldsOf(open)).toEqual(roster.fields);
      expect(groupableFieldsOf(roster)).toEqual(["categoryId"]);
      const schema = resourceListQuery(z.object({}), open);
      expect(schema.parse(asRouterQuery("groupBy=name"))).toEqual({
        groupBy: "name",
      });
    });

    it("lists the roster in the parameter descriptions", () => {
      if (!(rostered instanceof z.ZodObject))
        throw new Error("resource query is an object schema");
      expect(rostered.shape.sort?.description).toContain(
        "Fields: name, createdAt, categoryId. Default: -createdAt",
      );
      expect(rostered.shape.groupBy?.description).toBe(
        "Group rows by one field. One of: categoryId",
      );
    });
  });
});

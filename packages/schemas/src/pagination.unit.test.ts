import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildPaginatedResponse,
  buildTakeSkip,
  createPaginatedResponseSchema,
  sortPaginationCombo,
  type PaginationParams,
} from "./pagination";

describe("sortPaginationCombo", () => {
  it("defaults omitted sort to createdAt descending", () => {
    const result = sortPaginationCombo.parse({});

    expect(result.sort).toEqual({
      orderBy: "createdAt",
      direction: "desc",
    });
  });

  it("defaults partial sort direction to ascending", () => {
    const result = sortPaginationCombo.parse({
      sort: { orderBy: "name" },
    });

    expect(result.sort).toEqual({
      orderBy: "name",
      direction: "asc",
    });
  });

  it("defaults empty sort object to createdAt ascending", () => {
    const result = sortPaginationCombo.parse({
      sort: {},
    });

    expect(result.sort).toEqual({
      orderBy: "createdAt",
      direction: "asc",
    });
  });

  it("defaults explicit createdAt sort direction to ascending", () => {
    const result = sortPaginationCombo.parse({
      sort: { orderBy: "createdAt" },
    });

    expect(result.sort).toEqual({
      orderBy: "createdAt",
      direction: "asc",
    });
  });

  it("preserves explicit ascending and descending sort directions", () => {
    expect(
      sortPaginationCombo.parse({
        sort: { orderBy: "name", direction: "asc" },
      }).sort,
    ).toEqual({
      orderBy: "name",
      direction: "asc",
    });

    expect(
      sortPaginationCombo.parse({
        sort: { orderBy: "name", direction: "desc" },
      }).sort,
    ).toEqual({
      orderBy: "name",
      direction: "desc",
    });
  });
});

describe("buildPaginatedResponse", () => {
  it("builds correct response structure with data", () => {
    const pagination: PaginationParams = {
      pageIndex: 0,
      pageSize: 10,
    };
    const data = ["item1", "item2"];
    const count = 20;

    const result = buildPaginatedResponse(pagination, data, count);

    expect(result).toEqual({
      meta: {
        pageIndex: 0,
        pageSize: 10,
        totalCount: 20,
      },
      items: ["item1", "item2"],
    });
  });

  it("builds correct response with empty data", () => {
    const pagination: PaginationParams = {
      pageIndex: 0,
      pageSize: 10,
    };
    const data: string[] = [];
    const count = 0;

    const result = buildPaginatedResponse(pagination, data, count);

    expect(result).toEqual({
      meta: {
        pageIndex: 0,
        pageSize: 10,
        totalCount: 0,
      },
      items: [],
    });
  });
});

describe("createPaginatedResponseSchema", () => {
  it("creates schema with correct structure", () => {
    const itemSchema = z.object({ id: z.string(), name: z.string() });
    const schema = createPaginatedResponseSchema(itemSchema);

    const validData = {
      meta: {
        pageIndex: 0,
        pageSize: 10,
        totalCount: 1,
      },
      items: [{ id: "1", name: "test" }],
    };

    expect(() => schema.parse(validData)).not.toThrow();
  });
});

describe("buildTakeSkip", () => {
  it("calculates correct skip and take values", () => {
    const pagination: PaginationParams = {
      pageIndex: 2,
      pageSize: 10,
    };

    const result = buildTakeSkip(pagination);

    expect(result).toEqual({
      skip: 20,
      take: 10,
    });
  });

  it("handles zero pageIndex", () => {
    const pagination: PaginationParams = {
      pageIndex: 0,
      pageSize: 5,
    };

    const result = buildTakeSkip(pagination);

    expect(result).toEqual({
      skip: 0,
      take: 5,
    });
  });
});

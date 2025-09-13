import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  buildPaginatedResponse,
  buildTakeSkip,
  createPaginatedResponseSchema,
  type PaginationParams,
} from "./pagination";

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

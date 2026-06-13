import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractDbTimestampsFromDBRec } from "./common";
import {
  buildPaginatedResponse,
  buildTakeSkip,
  createPaginatedResponseSchema,
  type PaginationParams,
} from "./pagination";

describe("buildPaginatedResponse", () => {
  it("builds correct response structure with data", () => {
    const pagination: PaginationParams = {
      pageIndex: 2,
      pageSize: 15,
    };
    const data = [
      { id: "1", name: "Test" },
      { id: "2", name: "Test 2" },
    ];
    const count = 45;

    const result = buildPaginatedResponse(pagination, data, count);

    expect(result).toEqual({
      meta: {
        pageIndex: 2,
        pageSize: 15,
        totalCount: 45,
      },
      items: data,
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
    const testSchema = z.object({
      id: z.string(),
      name: z.string(),
    });

    const paginatedSchema = createPaginatedResponseSchema(testSchema);

    // Validate the structure
    expect(paginatedSchema).toBeDefined();

    // Test validation with a valid object
    const validObject = {
      meta: {
        pageIndex: 0,
        pageSize: 10,
        totalCount: 25,
      },
      items: [{ id: "1", name: "Test" }],
    };

    const parsed = paginatedSchema.safeParse(validObject);
    expect(parsed.success).toBe(true);

    // Test validation with an invalid object
    const invalidObject = {
      meta: {
        pageIndex: 0,
        pageSize: 10,
        totalCount: 25,
      },
      items: [
        { id: 123, name: "Test" }, // id should be string
      ],
    };

    const parsedInvalid = paginatedSchema.safeParse(invalidObject);
    expect(parsedInvalid.success).toBe(false);
  });
});

describe("buildTakeSkip", () => {
  it("calculates correct skip and take values", () => {
    const pagination: PaginationParams = {
      pageIndex: 3,
      pageSize: 25,
    };

    const result = buildTakeSkip(pagination);

    expect(result).toEqual({
      skip: 75, // 3 * 25
      take: 25,
    });
  });

  it("handles zero pageIndex", () => {
    const pagination: PaginationParams = {
      pageIndex: 0,
      pageSize: 10,
    };

    const result = buildTakeSkip(pagination);

    expect(result).toEqual({
      skip: 0,
      take: 10,
    });
  });
});

describe("extractDbTimestampsFromDBRec", () => {
  it("extracts timestamp fields correctly", () => {
    const now = new Date();
    const dbRecord = {
      id: "123",
      name: "Test Record",
      createdAt: now,
      updatedAt: now,
      extraField: "extra",
    };

    const result = extractDbTimestampsFromDBRec(dbRecord);

    expect(result).toEqual({
      createdAt: now,
      updatedAt: now,
    });

    // Ensure it doesn't include other fields
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("name");
    expect(result).not.toHaveProperty("extraField");
  });
});

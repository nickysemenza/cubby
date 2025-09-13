import { describe, it, expect } from "vitest";
import { extractDbTimestampsFromDBRec } from "./common";

describe("extractDbTimestampsFromDBRec", () => {
  it("extracts timestamp fields correctly", () => {
    const dbRecord = {
      id: "123",
      name: "test",
      createdAt: new Date("2023-01-01"),
      updatedAt: new Date("2023-01-02"),
      otherField: "ignored",
    };

    const result = extractDbTimestampsFromDBRec(dbRecord);

    expect(result).toEqual({
      createdAt: new Date("2023-01-01"),
      updatedAt: new Date("2023-01-02"),
    });
  });
});

import { describe, expect, it } from "vitest";
import { recipeExportSearchSchema } from "./-recipe-export-search";

describe("recipe export format contract", () => {
  it("accepts the plain Read sheet with scaling", () => {
    expect(
      recipeExportSearchSchema.parse({ format: "read", scale: 1.5 }),
    ).toEqual({ format: "read", scale: 1.5 });
  });

  it("falls back safely for unknown formats", () => {
    expect(recipeExportSearchSchema.parse({ format: "unknown" })).toEqual({
      format: undefined,
    });
  });
});

import { describe, expect, it } from "vitest";
import { withFailure, withSuccess } from "./result-types";

describe("withSuccess", () => {
  it("should create successful result", () => {
    const result = withSuccess("test");
    expect(result).toEqual({
      success: true,
      value: "test",
    });
  });

  it("should handle different value types", () => {
    const result = withSuccess({ id: 1, name: "test" });
    expect(result).toEqual({
      success: true,
      value: { id: 1, name: "test" },
    });
  });
});

describe("withFailure", () => {
  it("should create failure result", () => {
    const result = withFailure("error message");
    expect(result).toEqual({
      success: false,
      error: "error message",
    });
  });

  it("should handle different error types", () => {
    const result = withFailure(404);
    expect(result).toEqual({
      success: false,
      error: 404,
    });
  });
});

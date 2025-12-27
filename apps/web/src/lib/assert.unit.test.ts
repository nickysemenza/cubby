import { describe, expect, it } from "vitest";
import { assertNever } from "./assert";

describe("assertNever", () => {
  it("should throw error with JSON stringified value", () => {
    // This test uses 'as never' to bypass TypeScript's type checking
    // In real usage, this would be caught at compile time
    expect(() => assertNever("unexpected" as never)).toThrow(
      'Unhandled discriminated union member: "unexpected"',
    );
  });

  it("should throw error with object value", () => {
    const obj = { key: "value" };
    expect(() => assertNever(obj as never)).toThrow(
      'Unhandled discriminated union member: {"key":"value"}',
    );
  });

  it("should throw error with number value", () => {
    expect(() => assertNever(42 as never)).toThrow(
      "Unhandled discriminated union member: 42",
    );
  });

  it("should throw error with null value", () => {
    expect(() => assertNever(null as never)).toThrow(
      "Unhandled discriminated union member: null",
    );
  });
});

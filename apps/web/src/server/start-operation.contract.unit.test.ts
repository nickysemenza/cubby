import { describe, expect, it } from "vitest";

import { unparsedStartOperationDataSchema } from "./start-operation.contract";

describe("Start operation serializable carrier", () => {
  it("preserves TanStack-supported undefined, Date, collections, and nesting", () => {
    const occurredAt = new Date("2026-08-28T00:00:00.000Z");
    const input = {
      occurredAt,
      optional: undefined,
      nested: [{ value: 1 }, undefined],
      selected: new Set(["one", "two"]),
      indexed: new Map([["created", occurredAt]]),
    };

    expect(unparsedStartOperationDataSchema.parse(input)).toEqual(input);
  });

  it("rejects values outside TanStack's serializable carrier", () => {
    expect(() =>
      unparsedStartOperationDataSchema.parse({ callback: () => undefined }),
    ).toThrow(/Invalid input/);
    expect(() =>
      unparsedStartOperationDataSchema.parse(Symbol("invalid")),
    ).toThrow(/Invalid input/);
  });
});

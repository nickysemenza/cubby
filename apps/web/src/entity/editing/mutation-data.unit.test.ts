import { describe, expect, it } from "vitest";

import {
  parseEntityEditBulkUpdateInput,
  parseEntityEditCreateInput,
  parseEntityEditUpdateInput,
} from "./mutation-data";

describe("entity editing mutation data", () => {
  it("applies the owner create and update schemas", () => {
    expect(
      parseEntityEditCreateInput("task", {
        name: "Wire shelves",
        trade: "building",
      }),
    ).toMatchObject({ name: "Wire shelves", status: "not_started" });
    expect(parseEntityEditUpdateInput("task", { status: "done" })).toEqual({
      status: "done",
    });
  });

  it("uses the derived bulk-update schema and excludes identity fields", () => {
    expect(parseEntityEditBulkUpdateInput("task", { status: "done" })).toEqual({
      status: "done",
    });
    expect(() =>
      parseEntityEditBulkUpdateInput("ingredient", { name: "Flour" }),
    ).toThrow(/Unrecognized key/);
    for (const usuallyOnHand of [true, false]) {
      expect(
        parseEntityEditBulkUpdateInput("ingredient", { usuallyOnHand }),
      ).toEqual({ usuallyOnHand });
    }
    expect(() =>
      parseEntityEditBulkUpdateInput("recipe", { name: "Soup" }),
    ).toThrow(/Unrecognized key/);
    expect(
      parseEntityEditBulkUpdateInput("recipe", {
        notes: "Synthetic shared note",
      }),
    ).toEqual({ notes: "Synthetic shared note" });
  });
});

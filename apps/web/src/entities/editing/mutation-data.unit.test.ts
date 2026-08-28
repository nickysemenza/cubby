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

  it("uses only an entity's declared bulk-update schema", () => {
    expect(parseEntityEditBulkUpdateInput("task", { status: "done" })).toEqual({
      status: "done",
    });
    expect(() =>
      parseEntityEditBulkUpdateInput("ingredient", { name: "Flour" }),
    ).toThrow("ingredient does not support bulk update");
  });
});

import { describe, expect, it } from "vitest";
import { collection } from "./collection.functions";

describe("Collection operation catalog", () => {
  it("binds every operation to the shared Start transport", () => {
    const helpers = [
      collection.list.queryOptions(null),
      collection.detail.queryOptions({ collection: "painting" }),
      collection.matrix.queryOptions({ subject: "location" }),
      collection.set.mutationOptions(),
      collection.create.mutationOptions(),
    ];

    expect(helpers.map((helper) => helper.meta)).toEqual([
      expect.objectContaining({
        operation: "collection.list",
        transport: "start",
      }),
      expect.objectContaining({
        operation: "collection.detail",
        transport: "start",
      }),
      expect.objectContaining({
        operation: "collection.matrix",
        transport: "start",
      }),
      expect.objectContaining({
        operation: "collection.set",
        transport: "start",
      }),
      expect.objectContaining({
        operation: "collection.create",
        transport: "start",
      }),
    ]);
  });
});

import { describe, expect, it } from "vitest";

import type { ListQueryOptionsFn } from "~/ui/hooks/use-paginated-table-core";

import { loadSelectionRecords } from "./selection-records";

describe("selected-record action admission", () => {
  it("resolves every selected identity in bounded requests without changing scope or order", async () => {
    const calls: string[][] = [];
    const queryOptions: ListQueryOptionsFn<
      { ids?: string[]; category: string },
      { id: string }
    > = ({ filters }) => {
      expect(filters.category).toBe("tools");
      const ids = filters.ids ?? [];
      calls.push(ids);
      return {
        queryKey: ["selection", ids],
        execute: async () => ({
          items: [...ids].reverse().map((id) => ({ id })),
          meta: {
            hasNextPage: false,
            pageIndex: 0,
            pageSize: 100,
            totalCount: ids.length,
          },
        }),
      };
    };
    const ids = Array.from({ length: 101 }, (_, index) => `synthetic-${index}`);
    const rows = await loadSelectionRecords({
      ids,
      filters: { category: "tools" },
      queryOptions,
      signal: new AbortController().signal,
    });
    expect(calls.map((batch) => batch.length)).toEqual([100, 1]);
    expect(rows.map(({ id }) => id)).toEqual(ids);
  });

  it("refuses an incomplete selected population instead of admitting an action on a subset", async () => {
    const queryOptions: ListQueryOptionsFn<object, { id: string }> = () => ({
      queryKey: ["missing"],
      execute: async () => ({
        items: [{ id: "present" }],
        meta: {
          hasNextPage: false,
          pageIndex: 0,
          pageSize: 100,
          totalCount: 1,
        },
      }),
    });
    await expect(
      loadSelectionRecords({
        ids: ["present", "gone"],
        filters: {},
        queryOptions,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("no longer match");
  });

  it("does not read records after the list scope cancels the action", async () => {
    const controller = new AbortController();
    controller.abort();
    const queryOptions: ListQueryOptionsFn<object, { id: string }> = () => {
      throw new Error("A cancelled selection must not query");
    };
    await expect(
      loadSelectionRecords({
        ids: ["present"],
        filters: {},
        queryOptions,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });
});

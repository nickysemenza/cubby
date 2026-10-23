import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { listReadFields } from "~/entity/model/list-read-schema";
import { entityList } from "~/integrations/tanstack-query/generated/catalog/entityList.gen";
import type { ListQueryOptionsFn } from "~/ui/hooks/use-paginated-table-core";

import { loadSelectionRecords } from "./selection-records";

describe("selected-record action admission", () => {
  const id = testShortcode("product", "selected-field-hydration");
  const readDeferred = (
    mode: "complete" | "missing acknowledgement" | "missing row",
  ) => {
    const operation = entityList.listEnrichment.withTransport(
      async ({ input }) => {
        const fields = z
          .array(z.enum(listReadFields("product").derived))
          .parse(input.fields);
        expect(fields).toEqual(["unitPrice"]);
        return {
          entity: "product",
          groups: [
            {
              id: "derived",
              fields: mode === "missing acknowledgement" ? [] : fields,
              state: "ready",
              data: mode === "missing row" ? [] : [{ id, unitPrice: null }],
            },
          ],
          missingIds: [],
        };
      },
    );
    const queryOptions: ListQueryOptionsFn<object, { id: string }> = () => ({
      queryKey: ["selected-fields"],
      execute: async () => ({
        items: [{ id }],
        meta: { pageIndex: 0, pageSize: 100, totalCount: 1 },
        deferredGroups: [{ id: "derived", fields: ["unitPrice"] }],
      }),
      progressive: {
        enrich: (ids, fields, signal) =>
          operation.call({ entity: "product", ids, fields }, { signal }),
        summary: async () => ({}),
      },
    });
    return loadSelectionRecords({
      ids: [id],
      filters: {},
      queryOptions,
      signal: new AbortController().signal,
    });
  };
  it("hydrates selected actions using advertised fields through the validating operation", async () => {
    await expect(readDeferred("complete")).resolves.toEqual([
      { id, unitPrice: null },
    ]);
  });
  it.each(["missing acknowledgement", "missing row"] as const)(
    "refuses incomplete action enrichment: %s",
    async (mode) => {
      await expect(readDeferred(mode)).rejects.toThrow(
        mode === "missing row"
          ? "Missing derived enrichment row"
          : "acknowledgement",
      );
    },
  );

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
          meta: { pageIndex: 0, pageSize: 100, totalCount: ids.length },
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
        meta: { pageIndex: 0, pageSize: 100, totalCount: 1 },
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

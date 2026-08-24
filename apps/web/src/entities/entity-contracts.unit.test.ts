import { countableEntities } from "@cubby/schemas/entity-manifest";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "~/lib/query-keys";
import { getEntityContract } from "./entity-contracts";

describe("entity-contracts drift guard", () => {
  it.each(countableEntities)(
    "%s mutations invalidate the shared dashboard count",
    (entity) => {
      expect(getEntityContract(entity).invalidationKeys).toContainEqual(
        queryKeys.dashboard.counts,
      );
    },
  );
});

describe("kernel browser transport", () => {
  it("maps generated list contracts onto entity.query while preserving list cache keys", async () => {
    const queryFn = vi.fn(async () => ({
      action: "list",
      entity: "product",
      items: [{ id: "PRD-1", name: "Hammer" }],
      meta: { pageIndex: 0, pageSize: 10, totalCount: 1 },
    }));
    const queryOptions = vi.fn(() => ({
      queryKey: [["entity", "query"]],
      queryFn,
    }));
    const api = { entity: { query: { queryOptions } } };
    const params = {
      filters: {},
      sort: { orderBy: "name", direction: "asc" as const },
      pagination: { pageIndex: 0, pageSize: 10 },
    };

    const options = getEntityContract("product").query.list?.(
      api as never,
      params,
    ) as {
      queryKey: unknown;
      queryFn: (context: { queryKey: never }) => Promise<unknown>;
    };

    expect(queryOptions).toHaveBeenCalledWith({
      action: "list",
      entity: "product",
      ...params,
    });
    expect(options.queryKey).toEqual([["product", "list"], { input: params }]);
    await expect(
      options.queryFn({ queryKey: options.queryKey as never }),
    ).resolves.toEqual({
      items: [{ id: "PRD-1", name: "Hammer" }],
      meta: { pageIndex: 0, pageSize: 10, totalCount: 1 },
    });
  });

  it("maps generated mutation contracts onto entity.mutate and unwraps results", async () => {
    const transport = vi.fn(async () => ({
      action: "create",
      entity: "product",
      item: { id: "PRD-1", name: "Hammer" },
      sideEffects: { backgroundBatches: [] },
    }));
    const mutationOptions = vi.fn(() => ({ mutationFn: transport }));
    const api = { entity: { mutate: { mutationOptions } } };
    const options = getEntityContract("product").mutation.create?.(
      api as never,
      {} as never,
    ) as { mutationFn: (variables: unknown) => Promise<unknown> };

    await expect(options.mutationFn({ name: "Hammer" })).resolves.toEqual({
      id: "PRD-1",
      name: "Hammer",
    });
    expect(transport).toHaveBeenCalledWith({
      action: "create",
      entity: "product",
      data: { name: "Hammer" },
    });
  });
});

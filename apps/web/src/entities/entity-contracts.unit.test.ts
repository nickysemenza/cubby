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
  it("maps generated list contracts onto Start-compatible list cache keys", () => {
    const params = {
      filters: {},
      sort: { orderBy: "name", direction: "asc" as const },
      pagination: { pageIndex: 0, pageSize: 10 },
    };

    const options = getEntityContract("product").query.list?.(
      {} as never,
      params,
    ) as {
      queryKey: unknown;
      queryFn: unknown;
    };

    expect(options.queryKey).toEqual([["product", "list"], { input: params }]);
    expect(options.queryFn).toEqual(expect.any(Function));
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

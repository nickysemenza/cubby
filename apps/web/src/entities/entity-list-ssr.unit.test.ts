import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureEntityListSsr, entityListDefaultSort } from "./entity-list-ssr";

afterEach(() => vi.restoreAllMocks());

describe("entityListDefaultSort", () => {
  it("matches the route-primary table defaults that establish hydration keys", () => {
    expect(entityListDefaultSort("vendor")).toEqual({
      orderBy: "spend",
      direction: "desc",
    });
    expect(entityListDefaultSort("financialAccount")).toEqual({
      orderBy: "name",
      direction: "asc",
    });
    expect(entityListDefaultSort("financialTransaction")).toEqual({
      orderBy: "transactionDate",
      direction: "desc",
    });
  });
});

describe("ensureEntityListSsr", () => {
  it("loads by default and skips only an explicitly inactive alternate view", async () => {
    const queryClient = new QueryClient();
    const ensure = vi
      .spyOn(queryClient, "ensureInfiniteQueryData")
      .mockResolvedValue({ pages: [], pageParams: [] });

    await ensureEntityListSsr({
      queryClient,
      entity: "product",
      search: {},
    });
    await ensureEntityListSsr({
      queryClient,
      entity: "location",
      search: {},
      active: false,
    });

    expect(ensure).toHaveBeenCalledOnce();
  });
});

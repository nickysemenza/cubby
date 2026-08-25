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

  it("uses a route renderer's explicit opening sort in the hydration key", async () => {
    const queryClient = new QueryClient();
    const ensure = vi
      .spyOn(queryClient, "ensureInfiniteQueryData")
      .mockResolvedValue({ pages: [], pageParams: [] });

    await ensureEntityListSsr({
      queryClient,
      entity: "project",
      search: {},
      defaultSort: { orderBy: "startDate", direction: "desc" },
    });

    expect(ensure.mock.calls[0]?.[0].queryKey).toEqual([
      ["project", "list"],
      {
        input: expect.objectContaining({
          sort: [{ orderBy: "startDate", direction: "desc" }],
        }),
      },
      "__infinite__",
    ]);
  });

  it("does not start a route preload that is already abandoned", async () => {
    const queryClient = new QueryClient();
    const ensure = vi.spyOn(queryClient, "ensureInfiniteQueryData");
    const abortController = new AbortController();
    abortController.abort();

    await ensureEntityListSsr({
      queryClient,
      entity: "product",
      search: {},
      signal: abortController.signal,
    });

    expect(ensure).not.toHaveBeenCalled();
  });

  it("cancels a route preload abandoned after it starts", async () => {
    const queryClient = new QueryClient();
    let finishPreload: (() => void) | undefined;
    vi.spyOn(queryClient, "ensureInfiniteQueryData").mockReturnValue(
      new Promise((resolve) => {
        finishPreload = () => resolve({ pages: [], pageParams: [] });
      }),
    );
    const cancel = vi
      .spyOn(queryClient, "cancelQueries")
      .mockResolvedValue(undefined);
    const abortController = new AbortController();

    const preload = ensureEntityListSsr({
      queryClient,
      entity: "product",
      search: {},
      signal: abortController.signal,
    });
    abortController.abort();
    finishPreload?.();
    await preload;

    expect(cancel).toHaveBeenCalledOnce();
  });
});

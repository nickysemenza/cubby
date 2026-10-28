import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { attachRouterServerSsrUtils } from "@tanstack/react-router/ssr/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { metadataQueryClient } from "#web/tests/entity-metadata.ts";
import { compileEntityListInput, entityListFor } from "~/entity/entity-list";
import { declaredListReadProjection } from "~/entity/entity-list/list-read-demand";
import { publicEntityMetadataLoaders } from "~/entity/generated/entity-metadata-loaders.gen";
import { entityMetadata, entityMetadataQueryOptions } from "~/entity/metadata";
import { installEntityMetadataTransport } from "~/entity/metadata-transport";
import { entityListDefaultSort } from "~/entity/sortable-fields";
import { productListReadProjection } from "~/features/product/list-read";
import { infiniteOperationQueryKey } from "~/integrations/tanstack-query/operation-catalog";
import { loadEntityMetadata } from "~/server/entity-metadata/loader.server";

import {
  ensureEntityListSsr,
  searchWithInitialFilter,
} from "./entity-list-ssr";

const metadataClient = await metadataQueryClient();

afterEach(() => vi.restoreAllMocks());

describe("entityListDefaultSort", () => {
  it("matches the route-primary table defaults that establish hydration keys", () => {
    expect(entityListDefaultSort(metadataClient, "vendor")).toEqual({
      orderBy: "spend",
      direction: "desc",
    });
    expect(entityListDefaultSort(metadataClient, "financialAccount")).toEqual({
      orderBy: "name",
      direction: "asc",
    });
    expect(
      entityListDefaultSort(metadataClient, "financialTransaction"),
    ).toEqual({
      orderBy: "transactionDate",
      direction: "desc",
    });
  });
});

describe("searchWithInitialFilter", () => {
  it("opens the Run list on its declared default until the URL names a filter or clears it", () => {
    expect(searchWithInitialFilter(metadataClient, "run", {})).toMatchObject({
      trigger: "foreground,discovery,manual,backfill,scheduled",
      routine: "false",
    });
    expect(
      searchWithInitialFilter(metadataClient, "run", { filters: "none" }),
    ).toEqual({
      filters: "none",
    });
    expect(
      searchWithInitialFilter(metadataClient, "run", { trigger: "ephemeral" }),
    ).toEqual({
      trigger: "ephemeral",
    });
    expect(
      searchWithInitialFilter(metadataClient, "run", { status: "failed" }),
    ).toEqual({
      status: "failed",
    });
  });

  it("leaves an entity without a declared default alone", () => {
    const search = { sort: "name" };
    expect(searchWithInitialFilter(metadataClient, "product", search)).toBe(
      search,
    );
  });
});

describe("ensureEntityListSsr", () => {
  it("loads by default and skips only an explicitly inactive alternate view", async () => {
    const queryClient = await metadataQueryClient();
    const ensure = vi
      .spyOn(queryClient, "ensureInfiniteQueryData")
      .mockResolvedValue({ pages: [], pageParams: [] });

    await ensureEntityListSsr({
      queryClient,
      entity: "product",
      search: {},
      readProjection: productListReadProjection,
    });
    await ensureEntityListSsr({
      queryClient,
      entity: "location",
      search: {},
      active: false,
    });

    expect(ensure).toHaveBeenCalledOnce();
    const mountedPlan = entityListFor("product").selectedListQueryPlan(
      compileEntityListInput(
        queryClient,
        "product",
        {},
        {
          defaultSort: entityListDefaultSort(queryClient, "product"),
          fields: productListReadProjection(queryClient, "product", {
            createdAt: true,
            updatedAt: true,
          }),
        },
      ),
    );
    expect(ensure.mock.calls[0]?.[0].queryKey).toEqual(
      infiniteOperationQueryKey(mountedPlan.queryKey),
    );
  });

  it("uses declared sort defaults for secondary lists without route options", () => {
    expect(
      compileEntityListInput(
        metadataClient,
        "run",
        { purpose: "sweep", status: "running" },
        { pageSize: 1 },
      ).sort,
    ).toEqual([{ orderBy: "startedAt", direction: "desc" }]);
    expect(
      compileEntityListInput(metadataClient, "financialAccount", {}).sort,
    ).toEqual([{ orderBy: "name", direction: "asc" }]);
  });

  it("compiles a route renderer's explicit opening sort", () => {
    expect(declaredListReadProjection(metadataClient, "project")).toEqual(
      expect.arrayContaining(["taskProgress", "rollup"]),
    );
    const imageFields = declaredListReadProjection(metadataClient, "image");
    expect(imageFields).toEqual(
      expect.arrayContaining(["url", "status", "filename"]),
    );
    expect(imageFields).not.toContain("images");
    expect(
      productListReadProjection(metadataClient, "product", { tags: true }),
    ).toEqual(
      expect.arrayContaining([
        "aliases",
        "brandId",
        "brandName",
        "categoryId",
        "tags",
      ]),
    );
    const input = compileEntityListInput(
      metadataClient,
      "project",
      {},
      {
        defaultSort: { orderBy: "startDate", direction: "desc" },
      },
    );

    expect(input.sort).toEqual([{ orderBy: "startDate", direction: "desc" }]);
  });

  it("shares the operation infinite key and suspends retained grouping in Timeline", async () => {
    const groupBy = [
      { key: "tags" },
      { key: "createdAt", bucket: "month" },
    ] as const;
    const input = compileEntityListInput(metadataClient, "product", {
      groupBy: [...groupBy],
    });
    expect(input.groupBy).toEqual(groupBy);
    const finite = entityListFor("product").queryOptions(input);
    const ssr = entityListFor("product").infiniteQueryOptions(input);

    expect(ssr.queryKey).toEqual(infiniteOperationQueryKey(finite.queryKey));
    const queryClient = await metadataQueryClient();
    const ensure = vi
      .spyOn(queryClient, "ensureInfiniteQueryData")
      .mockResolvedValue({ pages: [], pageParams: [] });
    await ensureEntityListSsr({
      queryClient,
      entity: "task",
      search: { view: "timeline", groupBy: [{ key: "status" }] },
    });
    const ungrouped = entityListFor("task").browserInfiniteQueryOptions(
      compileEntityListInput(
        metadataClient,
        "task",
        {},
        {
          defaultSort: entityListDefaultSort(metadataClient, "task"),
          fields: declaredListReadProjection(metadataClient, "task"),
        },
      ),
    );
    expect(ensure.mock.calls[0]?.[0].queryKey).toEqual(ungrouped.queryKey);
  });

  it("allows incomplete filters while a conditional finite query is disabled", () => {
    expect(() =>
      entityListFor("inventory").queryOptions({
        sort: [{ orderBy: "createdAt", direction: "desc" }],
        pagination: { pageIndex: 0, pageSize: 100 },
        filters: { locationIdFilter: "" },
      }),
    ).not.toThrow();
  });

  it("does not start a route preload that is already abandoned", async () => {
    const queryClient = await metadataQueryClient();
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
    const queryClient = await metadataQueryClient();
    let finishPreload: (() => void) | undefined;
    const ensure = vi
      .spyOn(queryClient, "ensureInfiniteQueryData")
      .mockReturnValue(
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
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    abortController.abort();
    finishPreload?.();
    await preload;

    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("metadata SSR admission", () => {
  it("keeps failed initial, streamed and pending metadata imports inside their queries", async () => {
    const server = new QueryClient();
    const browser = new QueryClient();
    const makeRouter = (isServer: boolean, queryClient: QueryClient) => {
      const router = createRouter({
        routeTree: createRootRoute(),
        history: createMemoryHistory(),
        origin: "https://synthetic.invalid",
        isServer,
      });
      setupRouterSsrQueryIntegration({ router, queryClient });
      installEntityMetadataTransport(router);
      return router;
    };
    const serverRouter = makeRouter(true, server);
    const browserRouter = makeRouter(false, browser);
    attachRouterServerSsrUtils({ router: serverRouter, manifest: undefined });
    const product = await loadEntityMetadata("product");
    const inventory = await loadEntityMetadata("inventory");
    const expense = await loadEntityMetadata("expense");
    const failure = new Error("Synthetic metadata chunk failure");
    const mocks = (["product", "inventory", "expense"] as const).map((entity) =>
      vi.spyOn(publicEntityMetadataLoaders, entity).mockRejectedValue(failure),
    );
    const pending = Promise.withResolvers<typeof inventory>();
    try {
      server.setQueryData(
        entityMetadataQueryOptions("product").queryKey,
        product,
      );
      server.setQueryData(["ordinary", "initial"], "initial value");
      const pendingRead = server.fetchQuery({
        ...entityMetadataQueryOptions("inventory"),
        queryFn: () => pending.promise,
      });
      const state = await serverRouter.options.dehydrate?.();
      if (!state) throw new Error("Missing Query dehydration state");
      await browserRouter.options.hydrate?.(state);
      expect(
        browser.getQueryState(entityMetadataQueryOptions("product").queryKey)
          ?.error,
      ).toBe(failure);
      expect(browser.getQueryData(["ordinary", "initial"])).toBe(
        "initial value",
      );
      await server.fetchQuery({
        ...entityMetadataQueryOptions("expense"),
        queryFn: async () => expense,
      });
      await server.fetchQuery({
        queryKey: ["ordinary", "streamed"],
        queryFn: async () => "streamed value",
      });
      pending.resolve(inventory);
      await pendingRead;
      await server.fetchQuery({
        queryKey: ["ordinary", "later"],
        queryFn: async () => "later value",
      });
      serverRouter.serverSsr?.setRenderFinished();
      await vi.waitFor(() => {
        for (const entity of ["product", "inventory", "expense"] as const) {
          const query = browser.getQueryState(
            entityMetadataQueryOptions(entity).queryKey,
          );
          expect(query?.status).toBe("error");
          expect(query?.error).toBe(failure);
          expect(query?.data).toBeUndefined();
        }
        expect(browser.getQueryData(["ordinary", "streamed"])).toBe(
          "streamed value",
        );
        expect(browser.getQueryData(["ordinary", "later"])).toBe("later value");
      });
    } finally {
      for (const mock of mocks) mock.mockRestore();
      serverRouter.serverSsr?.cleanup();
      server.clear();
      browser.clear();
    }
  });

  it("observes mapped pending rejections when SSR cancels before transport consumption", async () => {
    const server = new QueryClient();
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory(),
      origin: "https://synthetic.invalid",
      isServer: true,
    });
    setupRouterSsrQueryIntegration({ router, queryClient: server });
    installEntityMetadataTransport(router);
    attachRouterServerSsrUtils({ router, manifest: undefined });
    const pending = server.fetchQuery({
      ...entityMetadataQueryOptions("product"),
      queryFn: () => new Promise<never>(() => {}),
    });
    void pending.catch(() => {});
    try {
      const state = await router.options.dehydrate?.();
      if (!state) throw new Error("Missing Query dehydration state");
      await server.cancelQueries();
      // Leave the mapped transport promise unconsumed for one event-loop turn.
      // Vitest reports an unhandled rejection if the adapter drops its observer.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(state.query.initial[0]?.promise).rejects.toBeDefined();
    } finally {
      router.serverSsr?.cleanup();
      server.clear();
    }
  });

  it("reconstructs initial, streamed and pending bundles before successful publication without refetching", async () => {
    const server = new QueryClient();
    const browser = new QueryClient();
    const unrelated = new QueryClient();
    const serverRouter = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory(),
      origin: "https://synthetic.invalid",
      isServer: true,
    });
    const browserRouter = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory(),
      origin: "https://synthetic.invalid",
      isServer: false,
    });
    setupRouterSsrQueryIntegration({
      router: serverRouter,
      queryClient: server,
    });
    setupRouterSsrQueryIntegration({
      router: browserRouter,
      queryClient: browser,
    });
    installEntityMetadataTransport(serverRouter);
    installEntityMetadataTransport(browserRouter);
    attachRouterServerSsrUtils({ router: serverRouter, manifest: undefined });
    const product = await loadEntityMetadata("product");
    const inventory = await loadEntityMetadata("inventory");
    const expense = await loadEntityMetadata("expense");
    const pending = Promise.withResolvers<typeof inventory>();
    const invalidSuccesses: unknown[] = [];
    const unsubscribe = browser.getQueryCache().subscribe(({ query }) => {
      if (
        query.queryKey[0] === "entity-metadata" &&
        query.state.status === "success"
      ) {
        if (
          query.state.data instanceof Promise ||
          typeof query.state.data === "string"
        )
          invalidSuccesses.push(query.state.data);
      }
    });
    try {
      server.setQueryData(
        entityMetadataQueryOptions("product").queryKey,
        product,
      );
      const pendingRead = server.fetchQuery({
        ...entityMetadataQueryOptions("inventory"),
        queryFn: () => pending.promise,
      });
      const state = await serverRouter.options.dehydrate?.();
      if (!state) throw new Error("Missing Query dehydration state");
      expect(JSON.stringify(state.query.initial)).not.toContain(
        "structuredSchemas",
      );
      await browserRouter.options.hydrate?.(state);
      expect(entityMetadata(browser, "product")).toEqual(product.primary);
      for (const dependency of product.dependencies)
        expect(entityMetadata(browser, dependency.entity)).toEqual(dependency);
      expect(() => entityMetadata(unrelated, "product")).toThrow(
        "must be loaded before use",
      );
      // A dependency is readable, but is not itself an admitted complete bundle.
      expect(
        browser.getQueryData(entityMetadataQueryOptions("inventory").queryKey),
      ).toBeUndefined();
      await server.fetchQuery({
        ...entityMetadataQueryOptions("expense"),
        queryFn: async () => expense,
      });
      pending.resolve(inventory);
      await pendingRead;
      serverRouter.serverSsr?.setRenderFinished();
      await vi.waitFor(() => {
        expect(entityMetadata(browser, "inventory")).toEqual(inventory.primary);
        expect(entityMetadata(browser, "expense")).toEqual(expense.primary);
      });
      const refetch = vi.fn(async () => {
        throw new Error("Unexpected metadata refetch");
      });
      for (const entity of ["product", "inventory", "expense"] as const) {
        const bundle = await browser.ensureQueryData({
          ...entityMetadataQueryOptions(entity),
          queryFn: refetch,
        });
        expect(bundle.primary.entity).toBe(entity);
      }
      expect(refetch).not.toHaveBeenCalled();
      expect(invalidSuccesses).toEqual([]);
    } finally {
      unsubscribe();
      serverRouter.serverSsr?.cleanup();
      server.clear();
      browser.clear();
      unrelated.clear();
    }
  });
});

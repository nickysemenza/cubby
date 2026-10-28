import { afterEach, describe, expect, it, vi } from "vitest";

import { metadataQueryClient } from "#web/tests/entity-metadata.ts";
import { compileEntityListInput, entityListFor } from "~/entity/entity-list";
import { declaredListReadProjection } from "~/entity/entity-list/list-read-demand";
import { entityListDefaultSort } from "~/entity/sortable-fields";
import { productListReadProjection } from "~/features/product/list-read";
import { infiniteOperationQueryKey } from "~/integrations/tanstack-query/operation-catalog";

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

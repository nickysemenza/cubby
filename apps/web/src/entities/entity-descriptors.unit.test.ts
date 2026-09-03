import { QueryClient, type FetchQueryOptions } from "@tanstack/react-query";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { OperationQueryKey } from "~/integrations/tanstack-query/operation-catalog";

import {
  type EntityDetailScoped,
  entityDetailFor,
} from "./entity-detail.functions";
import { type EntityListScoped, entityListFor } from "./entity-list.functions";
import type {
  EntityDetailByEntity,
  EntityDetailInputByEntity,
} from "./generated/entity-details.gen";
import type { EntityListResultByEntity } from "./generated/entity-lists.gen";

/**
 * Query keys are the persisted-cache and SSR-hydration contract: a changed key
 * silently strands every persisted entry and re-fetches every hydrated route.
 * These literals are the captured shapes of the positional helpers the scoped
 * descriptors replaced — assert against the literals, never old-versus-new, so
 * a refactor cannot make the comparison vacuous.
 */
const PRODUCT_LIST_INPUT = {
  filters: { nameFilter: "bolt", manufacturerExact: "Milwaukee" },
  sort: [{ orderBy: "name", direction: "asc" as const }],
  pagination: { pageIndex: 0, pageSize: 25 },
};

const KEYS = {
  detailCanonical: [
    "operation",
    "entity.detail",
    { entity: "product", input: { entity: "product", shortcode: "PRD-4K7M" } },
  ],
  detailAlias: [
    "operation",
    "entity.detail",
    {
      entity: "location",
      input: { entity: "location", shortcode: "LOC-4K7M" },
    },
  ],
  detailDisabled: [
    "operation",
    "entity.detail",
    { entity: "product", input: { entity: "product", shortcode: "" } },
  ],
  detailPlaceholder: [
    "operation",
    "entity.detail",
    {
      entity: "ingredient",
      input: { entity: "ingredient", shortcode: "ING-2222" },
    },
  ],
  list: [
    "operation",
    "entity.list",
    {
      entity: "product",
      input: {
        entity: "product",
        filters: { nameFilter: "bolt", manufacturerExact: "Milwaukee" },
        sort: [{ orderBy: "name", direction: "asc" }],
        pagination: { pageIndex: 0, pageSize: 25 },
      },
    },
  ],
  listSparse: [
    "operation",
    "entity.list",
    { entity: "product", input: { entity: "product", filters: {} } },
  ],
  listGroupBy: [
    "operation",
    "entity.list",
    {
      entity: "expense",
      input: {
        entity: "expense",
        filters: {},
        sort: [{ orderBy: "transactionDate", direction: "desc" }],
        pagination: { pageIndex: 0, pageSize: 50 },
        groupBy: "vendor",
      },
    },
  ],
  listUnparseable: [
    "operation",
    "entity.list",
    {
      entity: "product",
      input: {
        entity: "product",
        filters: { nameFilter: "bolt", manufacturerExact: "Milwaukee" },
        sort: [],
        pagination: { pageIndex: 0, pageSize: 25 },
      },
    },
  ],
  listInfinite: [
    "operation",
    "entity.list",
    "infinite",
    {
      entity: "product",
      input: {
        entity: "product",
        filters: { nameFilter: "bolt", manufacturerExact: "Milwaukee" },
        sort: [{ orderBy: "name", direction: "asc" }],
        pagination: { pageIndex: 0, pageSize: 25 },
      },
    },
  ],
} as const;

const DETAIL_POLICY = {
  persisted: {
    meta: {
      transport: "start",
      operation: "entity.detail",
      entity: "product",
      observedByTransport: true,
      cacheTags: [["entity", "detail"], ["product"]],
      persistence: "persist",
      freshness: {
        staleTime: 300000,
        gcTime: 86400000,
        refetchOnWindowFocus: true,
      },
    },
    staleTime: 300000,
    gcTime: 86400000,
    refetchOnWindowFocus: true,
  },
  memory: {
    meta: {
      transport: "start",
      operation: "entity.detail",
      entity: "task",
      observedByTransport: true,
      cacheTags: [["entity", "detail"], ["task"]],
      persistence: "memory",
    },
  },
} as const;

const LIST_POLICY = {
  meta: {
    transport: "start",
    operation: "entity.list",
    entity: "product",
    observedByTransport: true,
    cacheTags: [["entity", "list"], ["product"]],
    persistence: "memory",
    freshness: {
      staleTime: 120000,
      refetchOnWindowFocus: true,
    },
  },
  staleTime: 120000,
  refetchOnWindowFocus: true,
} as const;

/** The row type a set of query options resolves to. */
type QueryData<Options> = Options extends { queryFn?: infer Fn }
  ? Fn extends (...args: never[]) => infer Result
    ? Awaited<Result>
    : never
  : never;

const withoutFunctions = <
  TQueryFn,
  TQueryKey,
  TNextPageParam,
  TOptions extends {
    queryFn?: TQueryFn;
    queryKey?: TQueryKey;
    getNextPageParam?: TNextPageParam;
  },
>(
  options: TOptions,
): Omit<TOptions, "queryFn" | "queryKey" | "getNextPageParam"> => {
  const {
    queryFn: _queryFn,
    queryKey: _queryKey,
    getNextPageParam: _getNextPageParam,
    ...rest
  } = options;
  return rest;
};

const runQueryFn = <
  TData,
  TError,
  TSelected,
  TQueryKey extends readonly unknown[],
  TPageParam,
>(
  options: FetchQueryOptions<TData, TError, TSelected, TQueryKey, TPageParam>,
) =>
  new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }).fetchQuery(options);

describe("entity detail query keys", () => {
  it("keys on the canonical shortcode", () => {
    expect(entityDetailFor("product").queryKey("PRD-4K7M")).toEqual(
      KEYS.detailCanonical,
    );
    expect(entityDetailFor("product").queryKey("p-4k7m")).toEqual(
      KEYS.detailCanonical,
    );
    expect(entityDetailFor("location").queryKey("L-4K7M")).toEqual(
      KEYS.detailAlias,
    );
    expect(entityDetailFor("product").queryOptions("p-4k7m").queryKey).toEqual(
      KEYS.detailCanonical,
    );
  });

  it("builds a key for a disabled query without validating it", () => {
    expect(
      entityDetailFor("product").queryOptions("", { enabled: false }).queryKey,
    ).toEqual(KEYS.detailDisabled);
    expect(
      entityDetailFor("ingredient").queryOptions("ING-2222", { enabled: false })
        .queryKey,
    ).toEqual(KEYS.detailPlaceholder);
  });

  it("defers validation to the query function", async () => {
    await expect(
      runQueryFn(
        entityDetailFor("product").queryOptions("", { enabled: false }),
      ),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("carries the persistence and freshness policy of the entity", () => {
    expect(
      withoutFunctions(entityDetailFor("product").queryOptions("PRD-4K7M")),
    ).toEqual(DETAIL_POLICY.persisted);
    expect(
      withoutFunctions(entityDetailFor("task").queryOptions("TSK-4K7M")),
    ).toEqual(DETAIL_POLICY.memory);
    expect(
      withoutFunctions(
        entityDetailFor("task").queryOptions("TSK-4K7M", {
          enabled: false,
          staleTime: 1234,
        }),
      ),
    ).toEqual({ ...DETAIL_POLICY.memory, enabled: false, staleTime: 1234 });
  });
});

describe("entity list query keys", () => {
  it("keys on the parsed list input", () => {
    expect(
      entityListFor("product").queryOptions(PRODUCT_LIST_INPUT).queryKey,
    ).toEqual(KEYS.list);
    expect(
      entityListFor("product").queryOptions({ filters: {} }).queryKey,
    ).toEqual(KEYS.listSparse);
    expect(
      entityListFor("expense").queryOptions({
        filters: {},
        sort: [{ orderBy: "transactionDate", direction: "desc" }],
        pagination: { pageIndex: 0, pageSize: 50 },
        groupBy: "vendor",
      }).queryKey,
    ).toEqual(KEYS.listGroupBy);
  });

  it("falls back to the raw input when a conditional query cannot parse", () => {
    expect(
      entityListFor("product").queryOptions({ ...PRODUCT_LIST_INPUT, sort: [] })
        .queryKey,
    ).toEqual(KEYS.listUnparseable);
  });

  it("defers validation to the query function", async () => {
    await expect(
      runQueryFn(
        entityListFor("product").queryOptions({
          ...PRODUCT_LIST_INPUT,
          sort: [],
        }),
      ),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).rejects.toThrow();
  });

  it("normalizes the infinite key to the first page", () => {
    expect(
      entityListFor("product").infiniteQueryOptions({
        ...PRODUCT_LIST_INPUT,
        pagination: { pageIndex: 3, pageSize: 25 },
      }).queryKey,
    ).toEqual(KEYS.listInfinite);
  });

  it("pages until the reported total is covered", () => {
    const options =
      entityListFor("product").infiniteQueryOptions(PRODUCT_LIST_INPUT);
    const page = (pageIndex: number, totalCount: number) =>
      ({
        items: [],
        meta: { pageIndex, pageSize: 25, totalCount },
      }) satisfies EntityListResultByEntity["product"];
    expect(options.initialPageParam).toBe(0);
    expect(options.getNextPageParam(page(0, 60), [], 0, [])).toBe(1);
    expect(options.getNextPageParam(page(2, 60), [], 2, [])).toBeUndefined();
    expect(options.getNextPageParam(page(0, 25), [], 0, [])).toBeUndefined();
  });

  it("carries the freshness policy of the entity", () => {
    expect(
      withoutFunctions(
        entityListFor("product").queryOptions(PRODUCT_LIST_INPUT),
      ),
    ).toEqual(LIST_POLICY);
    expect(
      withoutFunctions(
        entityListFor("product").infiniteQueryOptions(PRODUCT_LIST_INPUT),
      ),
    ).toEqual({ ...LIST_POLICY, initialPageParam: 0 });
  });
});

describe("scoped entity descriptors", () => {
  it("produces the same detail keys as the helpers they replace", () => {
    expect(entityDetailFor("product").entity).toBe("product");
    expect(entityDetailFor("product").queryKey("p-4k7m")).toEqual(
      KEYS.detailCanonical,
    );
    expect(entityDetailFor("location").queryKey("L-4K7M")).toEqual(
      KEYS.detailAlias,
    );
    expect(
      entityDetailFor("product").queryOptions("", { enabled: false }).queryKey,
    ).toEqual(KEYS.detailDisabled);
    expect(
      entityDetailFor("ingredient").queryOptions("ING-2222", { enabled: false })
        .queryKey,
    ).toEqual(KEYS.detailPlaceholder);
    expect(
      withoutFunctions(entityDetailFor("product").queryOptions("PRD-4K7M")),
    ).toEqual(DETAIL_POLICY.persisted);
  });

  it("produces the same list keys as the helpers they replace", () => {
    const products = entityListFor("product");
    expect(products.entity).toBe("product");
    expect(products.queryKey(PRODUCT_LIST_INPUT)).toEqual(KEYS.list);
    expect(products.queryOptions(PRODUCT_LIST_INPUT).queryKey).toEqual(
      KEYS.list,
    );
    expect(products.queryKey({ filters: {} })).toEqual(KEYS.listSparse);
    expect(
      products.queryOptions({ ...PRODUCT_LIST_INPUT, sort: [] }).queryKey,
    ).toEqual(KEYS.listUnparseable);
    expect(
      products.infiniteQueryOptions({
        ...PRODUCT_LIST_INPUT,
        pagination: { pageIndex: 3, pageSize: 25 },
      }).queryKey,
    ).toEqual(KEYS.listInfinite);
    expect(withoutFunctions(products.queryOptions(PRODUCT_LIST_INPUT))).toEqual(
      LIST_POLICY,
    );
  });

  it("rejects an entity the operation is not registered for", () => {
    expect(
      // @ts-expect-error invalid entity labels must still be rejected at runtime
      () => entityDetailFor("not-an-entity"),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).toThrow();
    expect(
      // @ts-expect-error invalid entity labels must still be rejected at runtime
      () => entityListFor("not-an-entity"),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).toThrow();
  });

  it("infers input and output per entity, not across the union", () => {
    expectTypeOf(entityDetailFor("product").queryKey("PRD-4K7M")).toEqualTypeOf<
      OperationQueryKey<EntityDetailInputByEntity["product"]>
    >();
    expectTypeOf<
      QueryData<ReturnType<EntityDetailScoped<"product">["queryOptions"]>>
    >().toEqualTypeOf<EntityDetailByEntity["product"] | null>();
    expectTypeOf<
      QueryData<ReturnType<EntityListScoped<"recipe">["queryOptions"]>>
    >().toEqualTypeOf<EntityListResultByEntity["recipe"]>();
    entityListFor("recipe").queryOptions({
      // @ts-expect-error a product-only filter does not belong to recipe
      filters: { manufacturerExact: "Milwaukee" },
    });
  });
});

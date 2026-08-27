import { describe, expect, it } from "vitest";
import {
  entityDetailQueryKey,
  entityDetailQueryOptions,
  entityDetailRootKey,
} from "./entity-detail.functions";
import {
  entityInfiniteListQueryOptions,
  entityListQueryOptions,
  entityListRootKey,
} from "./entity-list.functions";

/**
 * Query keys are the persisted-cache and SSR-hydration contract: a changed key
 * silently strands every persisted entry and re-fetches every hydrated route.
 * These literals are the captured shapes of the helpers that predate the scoped
 * descriptors — assert against the literals, never old-versus-new, so the
 * delegates cannot make the comparison vacuous.
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
  detailRoot: ["operation", "entity.detail"],
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
  listRoot: ["operation", "entity.list"],
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
        refetchOnReconnect: true,
      },
    },
    staleTime: 300000,
    gcTime: 86400000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
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
      refetchOnReconnect: true,
    },
  },
  staleTime: 120000,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
} as const;

const withoutFunctions = (options: object) => {
  const {
    queryFn: _queryFn,
    queryKey: _queryKey,
    getNextPageParam: _getNextPageParam,
    ...rest
  } = options as Record<string, unknown>;
  return rest;
};

const runQueryFn = (options: object) =>
  (
    options as {
      queryFn: (context: {
        signal: AbortSignal;
        pageParam?: number;
      }) => Promise<unknown>;
    }
  ).queryFn({ signal: new AbortController().signal, pageParam: 0 });

describe("entity detail query keys", () => {
  it("keys on the canonical shortcode", () => {
    expect(entityDetailQueryKey("product", "PRD-4K7M")).toEqual(
      KEYS.detailCanonical,
    );
    expect(entityDetailQueryKey("product", "p-4k7m")).toEqual(
      KEYS.detailCanonical,
    );
    expect(entityDetailQueryKey("location", "L-4K7M")).toEqual(
      KEYS.detailAlias,
    );
    expect(entityDetailQueryOptions("product", "p-4k7m").queryKey).toEqual(
      KEYS.detailCanonical,
    );
    expect(entityDetailRootKey("product")).toEqual(KEYS.detailRoot);
  });

  it("builds a key for a disabled query without validating it", () => {
    expect(
      entityDetailQueryOptions("product", "", { enabled: false }).queryKey,
    ).toEqual(KEYS.detailDisabled);
    expect(
      entityDetailQueryOptions("ingredient", "ING-2222", { enabled: false })
        .queryKey,
    ).toEqual(KEYS.detailPlaceholder);
  });

  it("defers validation to the query function", async () => {
    await expect(
      runQueryFn(entityDetailQueryOptions("product", "", { enabled: false })),
    ).rejects.toThrow();
  });

  it("carries the persistence and freshness policy of the entity", () => {
    expect(
      withoutFunctions(entityDetailQueryOptions("product", "PRD-4K7M")),
    ).toEqual(DETAIL_POLICY.persisted);
    expect(
      withoutFunctions(entityDetailQueryOptions("task", "TSK-4K7M")),
    ).toEqual(DETAIL_POLICY.memory);
    expect(
      withoutFunctions(
        entityDetailQueryOptions("task", "TSK-4K7M", {
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
      entityListQueryOptions("product", PRODUCT_LIST_INPUT).queryKey,
    ).toEqual(KEYS.list);
    expect(entityListQueryOptions("product", { filters: {} }).queryKey).toEqual(
      KEYS.listSparse,
    );
    expect(
      entityListQueryOptions("expense", {
        filters: {},
        sort: [{ orderBy: "transactionDate", direction: "desc" }],
        pagination: { pageIndex: 0, pageSize: 50 },
        groupBy: "vendor",
      }).queryKey,
    ).toEqual(KEYS.listGroupBy);
    expect(entityListRootKey("product")).toEqual(KEYS.listRoot);
    // Documented current behavior: the root key ignores its entity argument.
    expect(entityListRootKey("wish")).toEqual(KEYS.listRoot);
  });

  it("falls back to the raw input when a conditional query cannot parse", () => {
    expect(
      entityListQueryOptions("product", { ...PRODUCT_LIST_INPUT, sort: [] })
        .queryKey,
    ).toEqual(KEYS.listUnparseable);
  });

  it("defers validation to the query function", async () => {
    await expect(
      runQueryFn(
        entityListQueryOptions("product", { ...PRODUCT_LIST_INPUT, sort: [] }),
      ),
    ).rejects.toThrow();
  });

  it("normalizes the infinite key to the first page", () => {
    expect(
      entityInfiniteListQueryOptions("product", {
        ...PRODUCT_LIST_INPUT,
        pagination: { pageIndex: 3, pageSize: 25 },
      }).queryKey,
    ).toEqual(KEYS.listInfinite);
  });

  it("pages until the reported total is covered", () => {
    const options = entityInfiniteListQueryOptions(
      "product",
      PRODUCT_LIST_INPUT,
    );
    const page = (pageIndex: number, totalCount: number) =>
      ({ meta: { pageIndex, pageSize: 25, totalCount } }) as never;
    expect(options.initialPageParam).toBe(0);
    expect(options.getNextPageParam(page(0, 60), [], 0, [])).toBe(1);
    expect(options.getNextPageParam(page(2, 60), [], 2, [])).toBeUndefined();
    expect(options.getNextPageParam(page(0, 25), [], 0, [])).toBeUndefined();
  });

  it("carries the freshness policy of the entity", () => {
    expect(
      withoutFunctions(entityListQueryOptions("product", PRODUCT_LIST_INPUT)),
    ).toEqual(LIST_POLICY);
    expect(
      withoutFunctions(
        entityInfiniteListQueryOptions("product", PRODUCT_LIST_INPUT),
      ),
    ).toEqual({ ...LIST_POLICY, initialPageParam: 0 });
  });
});

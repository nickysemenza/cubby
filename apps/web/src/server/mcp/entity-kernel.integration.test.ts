import { productCreateInput } from "@cubby/schemas/product";
import {
  recordSourceTransactionRecordsInput,
  sourceTransactionRecordFilters,
} from "@cubby/schemas/source-transaction-record";
import { testUserId } from "@cubby/schemas/testing";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { wishCreateInput } from "@cubby/schemas/wish";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { projectEntityResult } from "~/contracts/mcp-projections";
import { mock } from "~/lib/test/mock-schema";
import type { USDAClient } from "~/server/clients/usda";
import { getDb } from "~/server/db/helpers";
import { sourceTransactionRecord } from "~/server/db/schema";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { recipeLineCoverage } from "~/server/domains/recipe/operations/recipe.server";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import { systemPrincipal } from "~/server/http/authenticate";
import { requireActor } from "~/server/http/request-context";
import { createMcpServer, listMcpToolCatalog } from "~/server/mcp/server";
import { createBrowserOperationHandler } from "~/server/operation-runtime/browser-operation-dispatch";
import { dispatchStartOperation } from "~/server/operation-runtime/start-operation-dispatch.server";
import {
  createProductFixture,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { callMcpTool, kernelRequestContext } from "../testing/mcp-test-utils";
import type { ToolArguments } from "./tools/tool-registration";

/** One kernel command through the published tools: reads go to entity_read. */
const callKernel = (
  command: ToolArguments,
  entityKernel: Parameters<typeof kernelRequestContext>[0],
) =>
  callMcpTool(
    createMcpServer(),
    ["get", "list", "search"].includes(String(command.action))
      ? "entity_read"
      : "entity",
    command,
    kernelRequestContext(entityKernel),
    { entityKernel },
  );

// A scored entity's write summary carries its data-quality coverage beside
// the identity; a get summary does not (`contracts/mcp-projections.ts`).
const wishSummaryResultSchema = z.object({
  item: z
    .object({
      id: z.string(),
      name: z.string(),
      coverage: z
        .object({
          status: z.string().nullable(),
          missingChecks: z.array(z.string()),
          defectChecks: z.array(z.string()),
        })
        .strict()
        .optional(),
    })
    .strict(),
});
const listSummarySchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  meta: z.object({ totalCount: z.number().int() }),
});
const idResultSchema = z.object({
  item: z.object({ id: z.string() }).passthrough(),
});
const productUnitMappingSummarySchema = z
  .object({
    id: z.string(),
    a: z.object({ value: z.number(), unit: z.string() }).passthrough(),
    b: z.object({ value: z.number(), unit: z.string() }).passthrough(),
    source: z.string().nullable(),
  })
  .passthrough();
const productGetResultSchema = z.object({
  item: z
    .object({
      id: z.string(),
      unitMappings: z.array(productUnitMappingSummarySchema),
    })
    .passthrough(),
});

describe("MCP entity kernel boundary", () => {
  const ctx = withTestDb("mcp");

  it("filters source observation identities exactly across revisions and account scopes", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const observation = (
      providerTransactionId = "synthetic-provider-1",
      providerAccountId = "synthetic-account-1",
      providerAmount = -10,
    ) => ({
      providerTransactionId,
      providerAccountId,
      providerAmount,
      accountDescriptor: `Synthetic card ${providerAccountId}`,
      statementDate: "2026-05-04",
      rawDescription: "SYNTHETIC IDENTITY FILTER",
    });
    const intake = ({
      fingerprint,
      rows,
      source = "monarch",
      observedAt = "2026-06-01T00:00:00Z",
    }: {
      fingerprint: string;
      rows: ReturnType<typeof observation>[];
      source?: string;
      observedAt?: string;
    }) =>
      recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
          import: {
            source,
            fingerprint,
            observedAt,
            label: "Synthetic identity filters",
          },
          rows: rows.map((row, index) => ({ ...row, rowPosition: index + 1 })),
        }),
        ctx.actor,
      );
    await intake({
      fingerprint: "synthetic-filter-initial",
      rows: [
        observation(),
        observation("synthetic-provider-1", "synthetic-account-2"),
        observation("synthetic-provider-10"),
        observation("synthetic-provider-1", "synthetic-account-10"),
      ],
    });
    await intake({
      fingerprint: "synthetic-filter-revision",
      observedAt: "2026-06-02T00:00:00Z",
      rows: [observation("synthetic-provider-1", "synthetic-account-1", -12)],
    });
    await intake({
      fingerprint: "synthetic-filter-other-source",
      source: "copilot",
      rows: [observation()],
    });
    const before = await getDb(ctx.db).select().from(sourceTransactionRecord);
    const scoped = before.filter(
      (row) =>
        row.source === "monarch" &&
        row.providerTransactionId === "synthetic-provider-1" &&
        row.providerAccountId === "synthetic-account-1",
    );
    expect(scoped).toHaveLength(2);
    const head = scoped.find((row) => row.current);
    const previous = scoped.find((row) => !row.current);
    if (!head || !previous)
      throw new Error("Synthetic revision history missing");
    const response = z.object({
      items: z.array(z.object({ id: z.string(), current: z.boolean() })),
      meta: z.object({ totalCount: z.number() }),
    });
    const list = async (
      filters: z.input<typeof sourceTransactionRecordFilters>,
    ) => {
      const result = await callKernel(
        {
          action: "list",
          entity: "sourceTransactionRecord",
          filters,
          fields: ["id", "current"],
        },
        context,
      );
      expect(result.isError).not.toBe(true);
      return response.parse(result.structuredContent);
    };
    const identity = {
      source: "monarch",
      providerTransactionId: "synthetic-provider-1",
      providerAccountId: "synthetic-account-1",
    };
    const history = await list(identity);
    expect(history.meta.totalCount).toBe(2);
    expect(history.items.map((row) => row.id).sort()).toEqual(
      [head.shortcode, previous.shortcode].sort(),
    );
    expect(await list({ ...identity, current: true })).toMatchObject({
      items: [{ id: head.shortcode, current: true }],
      meta: { totalCount: 1 },
    });
    expect(await list({ ...identity, current: false })).toMatchObject({
      items: [{ id: previous.shortcode, current: false }],
      meta: { totalCount: 1 },
    });
    const otherAccount = before.find(
      (row) => row.providerAccountId === "synthetic-account-2",
    );
    if (!otherAccount) throw new Error("Synthetic distinct account missing");
    expect(
      await list({ ...identity, providerAccountId: ["synthetic-account-2"] }),
    ).toMatchObject({
      items: [{ id: otherAccount.shortcode }],
      meta: { totalCount: 1 },
    });
    expect(
      await list({ source: "monarch", chargeKey: head.chargeKey }),
    ).toMatchObject({
      meta: { totalCount: 2 },
    });
    expect(
      await list({
        source: "monarch",
        chargeKey: [head.chargeKey.slice(0, -1)],
      }),
    ).toMatchObject({ items: [], meta: { totalCount: 0 } });
    expect(await getDb(ctx.db).select().from(sourceTransactionRecord)).toEqual(
      before,
    );

    await executeEntity(context, {
      action: "delete",
      entity: "sourceTransactionRecord",
      ids: [head.shortcode],
    });
    expect(await list(identity)).toMatchObject({
      items: [{ id: previous.shortcode, current: false }],
      meta: { totalCount: 1 },
    });
    expect(await list({ ...identity, current: true })).toMatchObject({
      items: [],
      meta: { totalCount: 0 },
    });
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(sourceTransactionRecord)
          .where(eq(sourceTransactionRecord.id, head.id))
      )[0],
    ).toMatchObject({ deletedAt: expect.any(Date), current: true });
  });

  it("annotates read-only tools from the registry", async () => {
    // The registry's own annotations are the invariant, in both directions:
    // no tool that writes (`product_enrichment.find_or_create_by_upc` mints a Product) and no
    // read-only tool left out (`recipe_insights_read`, whose costing reads).
    const catalog = await listMcpToolCatalog();
    const readOnlyNames = catalog.tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name)
      .sort();
    expect(readOnlyNames).toContain("entity_read");
    expect(readOnlyNames).toContain("recipe_insights_read");
    expect(readOnlyNames).not.toContain("entity");
    expect(readOnlyNames).not.toContain("upc");
  });

  it("executes generated create, partial update, bulk marking, and delete definitions", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const created = await executeEntity(context, {
      action: "create",
      entity: "ingredient",
      data: {
        name: "Kernel staple",
        aliases: [],
        naKinds: [],
        usuallyOnHand: true,
      },
    });
    const id = created.item.id;
    expect(created.item.usuallyOnHand).toBe(true);
    const updated = await executeEntity(context, {
      action: "update",
      entity: "ingredient",
      id,
      data: { name: "Renamed kernel staple" },
    });
    expect(updated.item).toMatchObject({
      name: "Renamed kernel staple",
    });
    expect(
      (
        await executeEntity(context, {
          action: "get",
          entity: "ingredient",
          id,
          missing: "error",
        })
      ).item,
    ).toMatchObject({ usuallyOnHand: true });
    await executeEntity(context, {
      action: "bulkUpdate",
      entity: "ingredient",
      ids: [id],
      data: { usuallyOnHand: false },
    });
    const read = await executeEntity(context, {
      action: "get",
      entity: "ingredient",
      id,
      missing: "error",
    });
    expect(read.item?.usuallyOnHand).toBe(false);
    const removed = await executeEntity(context, {
      action: "delete",
      entity: "ingredient",
      ids: [id],
    });
    expect(removed.deletedReferences).toHaveLength(1);
    const missing = await executeEntity(context, {
      action: "get",
      entity: "ingredient",
      id,
      missing: "null",
    });
    expect(missing.item).toBeNull();
  });

  it("refuses an unknown sort or groupBy field as a client error, not a kernel crash", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    // Before this guard the roster check ran `field.parse` inside the run
    // stage, so an HTTP entity.list request with an unsupported sort answered 500 with a Sentry event.
    await expect(
      executeEntity(context, {
        action: "list",
        entity: "recipe",
        filters: {},
        sort: [{ orderBy: "bogus", direction: "asc" }],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "LIST_SORT_FIELD_UNSUPPORTED",
    });
    // Recipe once accepted `groupBy: "name"`; its declared roster replaced
    // that, and the refusal names the choices that remain.
    await expect(
      executeEntity(context, {
        action: "list",
        entity: "recipe",
        filters: {},
        groupBy: [{ key: "name" }],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "LIST_GROUP_BY_FIELD_UNSUPPORTED",
      message: 'Cannot group recipe by "name": unknown grouping field',
    });
  });

  it("refuses a declared field the compiler cannot order or group with its declared reason, unmasked", async () => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    // `effectiveOwner` is a filter-only predicate; a to-many `via` path
    // derives its reason into the same generated field, which HTTP and MCP
    // read through one kernel parse.
    const reason =
      'Cannot sort inventory by "effectiveOwner": Filter only: The effective owner is resolved from acquisition evidence outside SQL.';
    const command = {
      action: "list" as const,
      entity: "inventory" as const,
      filters: {},
      sort: [{ orderBy: "effectiveOwner", direction: "asc" as const }],
    };
    await expect(executeEntity(entityKernel, command)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "LIST_SORT_FIELD_UNSUPPORTED",
      message: reason,
    });
    const viaMcp = await callKernel(command, entityKernel);
    expect(viaMcp.isError).toBe(true);
    expect(JSON.stringify(viaMcp.content)).toContain(
      "Filter only: The effective owner is resolved",
    );
    const apiContext = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const http = createBrowserOperationHandler({
      authenticate: async () =>
        systemPrincipal(apiContext, { channel: "cli", credential: "api-key" }),
      dispatch: dispatchStartOperation,
    });
    const viaHttp = await http(
      new Request("https://cubby.example/api/operations/entity.list", {
        method: "POST",
        body: JSON.stringify({
          operation: "entity.list",
          input: {
            entity: command.entity,
            filters: {},
            sort: command.sort,
          },
        }),
        headers: {
          "content-type": "application/json",
          origin: "https://cubby.example",
        },
      }),
    );
    expect(viaHttp.status).toBe(400);
    expect(await viaHttp.json()).toMatchObject({
      code: "BAD_REQUEST",
      reason: "LIST_SORT_FIELD_UNSUPPORTED",
      message: reason,
    });

    // A declared text-array choice refuses an inapplicable calendar bucket.
    const groupReason =
      'Cannot group product by "tags": Tags does not support month buckets';
    const grouped = {
      action: "list" as const,
      entity: "product" as const,
      filters: {},
      groupBy: [{ key: "tags", bucket: "month" as const }],
    };
    await expect(executeEntity(entityKernel, grouped)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "LIST_GROUP_BY_FIELD_UNSUPPORTED",
      message: groupReason,
    });
    expect(
      JSON.stringify((await callKernel(grouped, entityKernel)).content),
    ).toContain("Tags does not support month buckets");
    const groupedViaHttp = await http(
      new Request("https://cubby.example/api/operations/entity.list", {
        method: "POST",
        body: JSON.stringify({
          operation: "entity.list",
          input: {
            entity: "product",
            filters: {},
            groupBy: [{ key: "tags", bucket: "month" as const }],
          },
        }),
        headers: {
          "content-type": "application/json",
          origin: "https://cubby.example",
        },
      }),
    );
    expect(groupedViaHttp.status).toBe(400);
    expect(await groupedViaHttp.json()).toMatchObject({
      reason: "LIST_GROUP_BY_FIELD_UNSUPPORTED",
      message: groupReason,
    });
  });

  it("runs a real protocol-to-kernel shortcode round trip", async () => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const callEntity = (command: ToolArguments) =>
      callKernel(command, entityKernel);

    const created = await callEntity({
      action: "create",
      entity: "wish",
      data: mock(wishCreateInput, {
        overrides: { name: "MCP kernel boundary wish" },
      }),
    });
    expect(created.isError).not.toBe(true);
    const createdWish = idResultSchema.parse(created.structuredContent).item;
    const other = await callEntity({
      action: "create",
      entity: "vendor",
      data: mock(vendorCreateInput, {
        overrides: { name: "MCP list filter vendor" },
      }),
    });
    const otherVendor = idResultSchema.parse(other.structuredContent).item;

    const fetched = await callEntity({
      action: "get",
      entity: "wish",
      id: createdWish.id,
    });
    expect(fetched.isError).not.toBe(true);
    expect(
      wishSummaryResultSchema.parse(fetched.structuredContent).item.name,
    ).toBe("MCP kernel boundary wish");

    const filtered = await callEntity({
      action: "list",
      entity: "vendor",
      filters: { ids: [otherVendor.id] },
    });
    expect(filtered.isError).not.toBe(true);
    expect(listSummarySchema.parse(filtered.structuredContent)).toMatchObject({
      items: [{ id: otherVendor.id, name: "MCP list filter vendor" }],
      meta: { totalCount: 1 },
    });

    const wrongPrefix = await callEntity({
      action: "get",
      entity: "wish",
      id: "VND-ABC123",
    });
    expect(wrongPrefix.isError).toBe(true);
  });

  it("answers a summary list with the full list's projection without loading enrichment", async () => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const callEntity = (command: ToolArguments) =>
      callKernel(command, entityKernel);
    const ids = await Promise.all(
      [
        { name: "Summary probe A", barcode: "012345678905", fdc_id: 2_000_001 },
        { name: "Summary probe B", barcode: "036000291452" },
        { name: "Summary probe C" },
      ].map(async (overrides) => {
        const created = await callEntity({
          action: "create",
          entity: "product",
          data: mock(productCreateInput, { overrides }),
        });
        return idResultSchema.parse(created.structuredContent).item.id;
      }),
    );
    const command = {
      action: "list",
      entity: "product",
      filters: { ids },
      sort: [{ orderBy: "name", direction: "desc" }],
      pagination: { pageIndex: 0, pageSize: 2 },
    };
    const findFoodsBatch = vi.fn(async (lookups: unknown[]) =>
      lookups.map(() => null),
    );
    const listKernel = {
      ...entityKernel,
      usdaClient: fromPartial<USDAClient>({ findFoodsBatch }),
    };
    const list = (input: ToolArguments) => callKernel(input, listKernel);

    const summary = await list(command);
    expect(summary.isError).not.toBe(true);
    // Summary detail publishes identity only; full reads use stored food facts.
    // Neither interactive read may call the USDA provider.
    expect(findFoodsBatch).not.toHaveBeenCalled();

    const full = await list({ ...command, resultDetail: "full" });
    expect(full.isError).not.toBe(true);
    expect(findFoodsBatch).not.toHaveBeenCalled();
    const fullResult = z
      .object({ action: z.literal("list"), entity: z.literal("product") })
      .passthrough()
      .parse(full.structuredContent);
    // A narrow read has provenance only for the inherited fields it loaded.
    const withoutDerived = z
      .object({
        meta: z
          .object({})
          .catchall(z.unknown())
          .transform(({ derived: _derived, ...meta }) => meta),
      })
      .passthrough();
    expect(withoutDerived.parse(summary.structuredContent)).toEqual(
      withoutDerived.parse(projectEntityResult({ action: "list" }, fullResult)),
    );
    expect(summary.structuredContent).toMatchObject({
      items: [
        { name: "Summary probe C" },
        {
          name: "Summary probe B",
          externalIds: [expect.objectContaining({ source: "gtin" })],
        },
      ],
      meta: { totalCount: 3 },
    });
  });

  it("keeps a product unit mapping's row id across `entity_read.get` product, so resending it updates in place", async () => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const callEntity = (command: ToolArguments) =>
      callKernel(command, entityKernel);

    const created = await callEntity({
      action: "create",
      entity: "product",
      data: mock(productCreateInput, {
        overrides: {
          name: "MCP unit-mapping probe",
          unitMappings: [
            {
              a: { value: 1, unit: "cup" },
              b: { value: 120, unit: "g" },
              source: null,
            },
          ],
        },
      }),
    });
    expect(created.isError).not.toBe(true);
    const productId = idResultSchema.parse(created.structuredContent).item.id;

    const fetched = await callEntity({
      action: "get",
      entity: "product",
      id: productId,
      resultDetail: "full",
    });
    expect(fetched.isError).not.toBe(true);
    const fetchedItem = productGetResultSchema.parse(
      fetched.structuredContent,
    ).item;
    expect(fetchedItem.unitMappings).toHaveLength(1);
    const mappingId = fetchedItem.unitMappings[0]!.id;
    // A raw uuid, never a public shortcode — the declared exception in
    // MCP_SERVER_INSTRUCTIONS (server.ts), same class as mealRecipe `id` and
    // recipe section `lineId`.
    expect(mappingId).not.toMatch(/^[A-Z]{3}-/);

    // Resend the SAME mapping WITH the id `get` just returned, changing only
    // its value. Without the id round-tripping, `syncProductUnitMappings`
    // (repo/product/update-helpers.ts) treats every resent mapping as new and
    // deletes+recreates the row instead of updating it in place.
    const updated = await callEntity({
      action: "update",
      entity: "product",
      id: productId,
      data: {
        unitMappings: [
          {
            id: mappingId,
            a: { value: 1, unit: "cup" },
            b: { value: 125, unit: "g" },
            source: null,
          },
        ],
      },
    });
    expect(updated.isError).not.toBe(true);

    const refetched = await callEntity({
      action: "get",
      entity: "product",
      id: productId,
      resultDetail: "full",
    });
    const refetchedItem = productGetResultSchema.parse(
      refetched.structuredContent,
    ).item;
    expect(refetchedItem.unitMappings).toHaveLength(1);
    expect(refetchedItem.unitMappings[0]!.id).toBe(mappingId);
    expect(refetchedItem.unitMappings[0]!.b).toMatchObject({
      value: 125,
      unit: "g",
    });
  });

  describe("entity.resolve for ingredients", () => {
    const resolveResultSchema = z.object({
      results: z.array(
        z.object({
          name: z.string(),
          id: z.string(),
          created: z.boolean(),
          candidateProducts: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              brandName: z.string().nullable(),
            }),
          ),
          linkedProduct: z.object({ id: z.string() }).optional(),
        }),
      ),
    });
    const kernel = () =>
      entityKernelContextSchema.parse(
        createTestRequestContext(ctx.db, {
          auth: { userId: testUserId("test-user-id") },
        }),
      );
    const indexedProduct = async (name: string) => {
      const created = await createProductFixture(
        ctx.db,
        makeProductInput({ name }),
        ctx.actor,
      );
      await refreshSearchDocument(ctx.db, "product", created.entityId);
      return created;
    };

    it("offers unlinked products as candidates and links one through the product update path", async () => {
      const entityKernel = kernel();
      const call = (args: ToolArguments) => callKernel(args, entityKernel);
      const fresh = await indexedProduct("Example Basil, Fresh 1 oz");
      const seeds = await indexedProduct("Example Basil Seeds");
      await indexedProduct("Unrelated Gadget");

      const first = await call({
        action: "resolve",
        entity: "ingredient",
        names: ["Example Basil"],
      });
      expect(first.isError).not.toBe(true);
      const [offered] = resolveResultSchema.parse(
        first.structuredContent,
      ).results;
      expect(offered?.created).toBe(true);
      expect(offered?.candidateProducts.map((c) => c.id).sort()).toEqual(
        [fresh.id, seeds.id].sort(),
      );

      const linked = await call({
        action: "resolve",
        entity: "ingredient",
        names: ["Example Basil"],
        linkProductId: fresh.id,
      });
      expect(linked.isError).not.toBe(true);
      const [afterLink] = resolveResultSchema.parse(
        linked.structuredContent,
      ).results;
      expect(afterLink?.linkedProduct?.id).toBe(fresh.id);
      // Linked through the normal update: the row now reads back linked, and
      // it is no longer an unlinked candidate.
      expect(afterLink?.candidateProducts.map((c) => c.id)).toEqual([seeds.id]);
      const read = await executeEntity(entityKernel, {
        action: "get",
        entity: "product",
        id: fresh.id,
        missing: "error",
      });
      expect(read.item?.ingredient?.id).toBe(afterLink?.id);
    });

    it("refuses linkProductId unless exactly one name is resolved", async () => {
      const entityKernel = kernel();
      const product = await indexedProduct("Example Thyme Bundle");
      const result = await callMcpTool(
        createMcpServer(),
        "entity",
        {
          action: "resolve",
          entity: "ingredient",
          names: ["Example Thyme", "Example Sage"],
          linkProductId: product.id,
        },
        kernelRequestContext(entityKernel),
        { entityKernel },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("recipe write coverage", () => {
    const lineCoverageSchema = z.object({
      item: z.object({ id: z.string() }).passthrough(),
      lineCoverage: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          missing: z.array(z.enum(["price", "weight", "nutrients"])),
        }),
      ),
    });

    it("returns bounded write receipts and loads line coverage through full detail", async () => {
      const entityKernel = entityKernelContextSchema.parse(
        createTestRequestContext(ctx.db, {
          auth: { userId: testUserId("test-user-id") },
        }),
      );
      const call = (args: ToolArguments) => callKernel(args, entityKernel);
      const [leek, thyme] = await Promise.all(
        ["coverage leek", "coverage thyme"].map((name) =>
          findOrCreateIngredient(ctx.db, name),
        ),
      );

      const created = await call({
        action: "create",
        entity: "recipe",
        data: makeRecipeInput({
          name: "Coverage soup",
          sections: [
            {
              name: "Soup",
              ingredients: [
                ingredientRef(leek!.shortcode, {
                  amounts: [{ value: 2, unit: "whole" }],
                }),
                ingredientRef(thyme!.shortcode, {
                  amounts: [{ value: 1, unit: "sprig" }],
                }),
              ],
              instructions: [{ instruction: "Simmer." }],
            },
          ],
        }),
      });
      expect(created.isError).not.toBe(true);
      const receipt = idResultSchema.parse(created.structuredContent);
      const summary = lineCoverageSchema.parse({
        item: receipt.item,
        lineCoverage: await recipeLineCoverage(entityKernel, receipt.item.id),
      });
      expect(summary.lineCoverage.map((line) => line.name)).toEqual([
        "coverage leek",
        "coverage thyme",
      ]);
      // No product backs either ingredient: nothing to price, weigh or
      // count nutrients from.
      expect(summary.lineCoverage.map((line) => line.missing)).toEqual([
        ["price", "weight", "nutrients"],
        ["price", "weight", "nutrients"],
      ]);

      const renamed = await call({
        action: "update",
        entity: "recipe",
        id: summary.item.id,
        data: { name: "Coverage soup, renamed" },
        resultDetail: "full",
      });
      expect(renamed.isError).not.toBe(true);
      expect(
        await recipeLineCoverage(entityKernel, summary.item.id),
      ).toHaveLength(2);
    });
  });
});

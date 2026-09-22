import { productCreateInput } from "@cubby/schemas/product";
import { testUserId } from "@cubby/schemas/testing";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { wishCreateInput } from "@cubby/schemas/wish";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { listMcpToolCatalog } from "~/server/mcp/server";
import { createTestRequestContext } from "~/server/testing/request-context";

import { callMcpTool } from "./mcp-test-utils";
import { registerEntityTools } from "./tools/entity.tools";
import type { ToolArguments } from "./tools/tool-registration";

// A scored entity's write summary carries its data-quality coverage beside
// the identity; a get summary does not (`response-projection.ts`).
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

  it("annotates read-only tools from the registry", async () => {
    // The registry's own annotations are the invariant, in both directions:
    // no tool that writes (`find_or_create_product_by_upc` mints a Product
    // despite its `find_` prefix) and no read-only tool left out because its
    // name lacks a list_/get_ prefix (`explain_recipe_costing`).
    const catalog = await listMcpToolCatalog();
    const readOnlyNames = catalog.tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name)
      .sort();
    expect(readOnlyNames).toContain("get_entities");
    expect(readOnlyNames).toContain("explain_recipe_costing");
    expect(readOnlyNames).not.toContain("entity");
    expect(readOnlyNames).not.toContain("find_or_create_product_by_upc");
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
      usuallyOnHand: true,
    });
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
    // stage, so `/api/v1/recipes?sort=bogus` answered 500 with a Sentry event.
    await expect(
      executeEntity(context, {
        action: "list",
        entity: "recipe",
        filters: {},
        sort: { orderBy: "bogus", direction: "asc" },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "LIST_SORT_FIELD_UNSUPPORTED",
    });
    await expect(
      executeEntity(context, {
        action: "list",
        entity: "product",
        filters: {},
        groupBy: "name",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "LIST_GROUP_BY_FIELD_UNSUPPORTED",
    });
  });

  it("runs a real protocol-to-kernel shortcode round trip", async () => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const callEntity = (command: ToolArguments, tool = "entity") => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      registerEntityTools(server);
      return callMcpTool(server, tool, { command }, {}, { entityKernel });
    };

    const created = await callEntity({
      action: "create",
      entity: "wish",
      data: mock(wishCreateInput, {
        overrides: { name: "MCP kernel boundary wish" },
      }),
    });
    expect(created.isError).not.toBe(true);
    const createdWish = wishSummaryResultSchema.parse(
      created.structuredContent,
    ).item;
    const other = await callEntity({
      action: "create",
      entity: "vendor",
      data: mock(vendorCreateInput, {
        overrides: { name: "MCP list filter vendor" },
      }),
    });
    const otherVendor = wishSummaryResultSchema.parse(
      other.structuredContent,
    ).item;

    const fetched = await callEntity(
      {
        action: "get",
        entity: "wish",
        id: createdWish.id,
      },
      "get_entities",
    );
    expect(fetched.isError).not.toBe(true);
    expect(
      wishSummaryResultSchema.parse(fetched.structuredContent).item.name,
    ).toBe("MCP kernel boundary wish");

    const filtered = await callEntity(
      {
        action: "list",
        entity: "vendor",
        filters: { ids: [otherVendor.id] },
      },
      "get_entities",
    );
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

  it("keeps a product unit mapping's row id across `entity get product`, so resending it updates in place", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerEntityTools(server);
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const callEntity = (command: ToolArguments, tool = "entity") =>
      callMcpTool(server, tool, { command }, {}, { entityKernel });

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

    const fetched = await callEntity(
      { action: "get", entity: "product", id: productId, resultDetail: "full" },
      "get_entities",
    );
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

    const refetched = await callEntity(
      { action: "get", entity: "product", id: productId, resultDetail: "full" },
      "get_entities",
    );
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
});

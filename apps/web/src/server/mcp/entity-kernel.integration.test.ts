import { productCreateInput } from "@cubby/schemas/product";
import { testUserId } from "@cubby/schemas/testing";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { wishCreateInput } from "@cubby/schemas/wish";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { createMcpServer, listMcpToolCatalog } from "~/server/mcp/server";
import { findOrCreateIngredient } from "~/server/repo/ingredient/crud";
import {
  createProductFixture,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";
import { refreshSearchDocument } from "~/server/repo/search-document";
import { createTestRequestContext } from "~/server/testing/request-context";

import { callMcpTool, kernelRequestContext } from "./mcp-test-utils";
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

  it("annotates read-only tools from the registry", async () => {
    // The registry's own annotations are the invariant, in both directions:
    // no tool that writes (`upc.find_or_create` mints a Product) and no
    // read-only tool left out (`recipe_insights`, whose costing reads).
    const catalog = await listMcpToolCatalog();
    const readOnlyNames = catalog.tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name)
      .sort();
    expect(readOnlyNames).toContain("entity_read");
    expect(readOnlyNames).toContain("recipe_insights");
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
        sort: [{ orderBy: "bogus", direction: "asc" }],
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
              manufacturer: z.string().nullable(),
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
      const call = (args: ToolArguments) =>
        callMcpTool(
          createMcpServer(),
          "entity",
          args,
          kernelRequestContext(entityKernel),
          { entityKernel },
        );
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

    it("reports per line what stops costing on create, update, and full detail", async () => {
      const entityKernel = entityKernelContextSchema.parse(
        createTestRequestContext(ctx.db, {
          auth: { userId: testUserId("test-user-id") },
        }),
      );
      const call = (args: ToolArguments) =>
        callMcpTool(
          createMcpServer(),
          "entity",
          args,
          kernelRequestContext(entityKernel),
          { entityKernel },
        );
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
      const summary = lineCoverageSchema.parse(created.structuredContent);
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
        lineCoverageSchema.parse(renamed.structuredContent).lineCoverage,
      ).toHaveLength(2);
    });
  });
});

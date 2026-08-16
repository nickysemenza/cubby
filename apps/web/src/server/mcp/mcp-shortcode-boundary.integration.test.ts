/**
 * The shortcode cutover, exercised end to end through the real MCP server
 * against a real Postgres — no uuid should ever need to cross this boundary.
 *
 * Every test drives tools the way an MCP client actually would: through
 * `client.callTool` over an in-memory transport, with a REAL tRPC caller
 * (`createTestCaller(domainRouter, ...)`) injected via the same
 * `authInfo.extra.caller` channel the production auth layer uses (mirrors
 * `callTool` in `server.unit.test.ts`, but with a live caller instead of a
 * stub, so shortcode resolution and the underlying repos actually run).
 *
 * The assertions below pin the finished public contract: canonical shortcodes
 * in both directions, with UUIDs retained only for explicitly declared child
 * rows and external identifiers.
 */

import { parseShortcode } from "@cubby/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { DomainCaller } from "~/server/api/domain";
import { domainRouter } from "~/server/api/domain";
import { createTestCaller } from "~/server/api/trpc";
import { createMcpServer, listMcpToolCatalog } from "./server";

// Harness

/**
 * Call a registered tool through a real client/server InMemoryTransport pair,
 * injecting a REAL tRPC caller via the same `authInfo.extra.caller` channel
 * the production auth layer uses. A fresh `McpServer` per call, mirroring
 * every call site in `server.unit.test.ts` — `McpServer.connect()` can only
 * run once per instance, so a round trip of several tool calls needs a fresh
 * server each time, not one shared connection.
 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  caller: DomainCaller,
): Promise<CallToolResult> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { token: "", clientId: "test", scopes: [], extra: { caller } },
    });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    return (await client.callTool({
      name,
      arguments: args,
    })) as CallToolResult;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

/** The text an errored tool call carries — the assertion message on failure. */
function errorText(result: CallToolResult): string {
  return JSON.stringify(result.content);
}

function structured(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/** Assert a tool call SUCCEEDED, with the actual error body in the message
 * when it didn't — saves a debugging round trip on every failure. */
function expectOk(result: CallToolResult) {
  expect(result.isError, errorText(result)).not.toBe(true);
}

/** Assert a shortcode string is well-formed and stamped for the given entity. */
function expectShortcode(value: unknown, entity: string) {
  expect(
    typeof value,
    `expected a ${entity} shortcode, got ${String(value)}`,
  ).toBe("string");
  expect(
    parseShortcode(value as string),
    `"${value}" is not a valid ${entity} shortcode`,
  ).toMatchObject({ type: entity, legacy: false });
}

// 1. list -> create -> get -> update -> delete round trips, per entity

describe("MCP CRUD round trips are driven by shortcodes only", () => {
  const ctx = withTestDb();

  it("location: create returns a usable shortcode, and parentId resolves (relationship field)", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const parent = await callTool(
      "create_location",
      { name: "Shortcode Pantry", type: "room", parentId: null },
      caller,
    );
    expectOk(parent);
    const parentOut = structured(parent);
    expectShortcode(parentOut.id, "location");
    const parentCode = parentOut.id as string;

    const child = await callTool(
      "create_location",
      { name: "Shortcode Shelf", type: "shelf", parentId: parentCode },
      caller,
    );
    expectOk(child);
    const childOut = structured(child);
    expectShortcode(childOut.id, "location");
    const childCode = childOut.id as string;
    // Relationship field resolves: parentId round-trips to the PARENT's
    // public id, not its private uuid.
    expect(childOut.parentId).toBe(parentCode);

    const listed = await callTool(
      "list_locations",
      { nameFilter: "Shortcode Shelf" },
      caller,
    );
    expectOk(listed);
    const items = structured(listed).items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(childCode);

    const got = await callTool("get_location", { id: childCode }, caller);
    expectOk(got);
    expect(structured(got).parentName).toBe("Shortcode Pantry");
    expect(structured(got).parentId).toBe(parentCode);

    const updated = await callTool(
      "update_location",
      { id: childCode, name: "Shortcode Shelf Renamed" },
      caller,
    );
    expectOk(updated);
    expect(structured(updated).name).toBe("Shortcode Shelf Renamed");
    // The shortcode never changes across an update.
    expect(structured(updated).id).toBe(childCode);

    const deleted = await callTool(
      "delete_locations",
      { ids: [childCode] },
      caller,
    );
    expectOk(deleted);
    expect(structured(deleted).deleted).toBe(1);

    const afterDelete = await callTool(
      "get_location",
      { id: childCode },
      caller,
    );
    expect(afterDelete.isError).toBe(true);
  });

  it("ingredient: create -> search -> get -> update -> delete", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const created = await callTool(
      "create_ingredient",
      { name: "Shortcode Basil", aliases: ["sweet basil"] },
      caller,
    );
    expectOk(created);
    expectShortcode(structured(created).id, "ingredient");
    const code = structured(created).id as string;

    const listed = await callTool(
      "search_ingredients",
      { nameFilter: "Shortcode Basil" },
      caller,
    );
    expectOk(listed);
    const items = structured(listed).items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toContain(code);

    const got = await callTool("get_ingredient", { id: code }, caller);
    expectOk(got);
    expect(structured(got).name).toBe("Shortcode Basil");

    const updated = await callTool(
      "update_ingredient",
      { id: code, name: "Shortcode Basil Renamed" },
      caller,
    );
    expectOk(updated);
    expect(structured(updated).name).toBe("Shortcode Basil Renamed");

    const deleted = await callTool(
      "delete_ingredients",
      { ids: [code] },
      caller,
    );
    expectOk(deleted);
    expect(structured(deleted).deleted).toBe(1);
  });

  it("product: create with an ingredient shortcode link -> search -> get -> update -> delete", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const ingredient = await callTool(
      "create_ingredient",
      { name: "Shortcode Flour", aliases: [] },
      caller,
    );
    expectOk(ingredient);
    const ingredientCode = structured(ingredient).id as string;

    const created = await callTool(
      "create_product",
      {
        name: "Shortcode Flour 5lb Bag",
        upc: null,
        manufacturer: "Test Mfg",
        ingredientId: ingredientCode,
      },
      caller,
    );
    expectOk(created);
    const createdOut = structured(created);
    expectShortcode(createdOut.id, "product");
    const productCode = createdOut.id as string;
    // Relationship field resolves: ingredientId round-trips to the
    // ingredient's public id.
    expect(createdOut.ingredientId).toBe(ingredientCode);

    const listed = await callTool(
      "search_products",
      { nameFilter: "Shortcode Flour 5lb Bag" },
      caller,
    );
    expectOk(listed);
    const items = structured(listed).items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toContain(productCode);

    const got = await callTool("get_product", { id: productCode }, caller);
    expectOk(got);
    expect(structured(got).ingredientId).toBe(ingredientCode);

    const updated = await callTool(
      "update_product",
      { id: productCode, name: "Shortcode Flour 5lb Bag v2" },
      caller,
    );
    expectOk(updated);
    expect(structured(updated).name).toBe("Shortcode Flour 5lb Bag v2");

    const deleted = await callTool(
      "delete_products",
      { ids: [productCode] },
      caller,
    );
    expectOk(deleted);
    expect(structured(deleted).deleted).toBe(1);
  });

  it("inventory: productId/locationId relationship fields resolve on create and get", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const product = await callTool(
      "create_product",
      {
        name: "Shortcode Canned Beans",
        upc: null,
        manufacturer: "Test Mfg",
        ingredientId: null,
      },
      caller,
    );
    expectOk(product);
    const productCode = structured(product).id as string;

    const location = await callTool(
      "create_location",
      { name: "Shortcode Cupboard", type: "shelf", parentId: null },
      caller,
    );
    expectOk(location);
    const locationCode = structured(location).id as string;

    const created = await callTool(
      "create_inventory_entry",
      {
        productId: productCode,
        locationId: locationCode,
        value: 3,
        unit: "each",
      },
      caller,
    );
    expectOk(created);
    const createdOut = structured(created);
    expectShortcode(createdOut.id, "inventory");
    const entryCode = createdOut.id as string;
    expect((createdOut.product as Record<string, unknown>)?.id).toBe(
      productCode,
    );
    expect((createdOut.location as Record<string, unknown>)?.id).toBe(
      locationCode,
    );

    const listed = await callTool(
      "list_inventory",
      { locationIdFilter: locationCode },
      caller,
    );
    expectOk(listed);
    const items = structured(listed).items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toContain(entryCode);

    const got = await callTool(
      "get_inventory_entry",
      { id: entryCode },
      caller,
    );
    expectOk(got);
    expect((structured(got).product as Record<string, unknown>)?.id).toBe(
      productCode,
    );

    const updated = await callTool(
      "update_inventory_entry",
      { id: entryCode, value: 5, unit: "each" },
      caller,
    );
    expectOk(updated);
    expect(structured(updated).amount).toEqual({ value: 5, unit: "each" });

    const deleted = await callTool(
      "delete_inventory_entries",
      { ids: [entryCode] },
      caller,
    );
    expectOk(deleted);
    expect(structured(deleted).deleted).toBe(1);
  });

  it("recipe: create with an ingredient-shortcode ref in sections -> list -> get -> update -> delete", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const ingredient = await callTool(
      "create_ingredient",
      { name: "Shortcode Garlic", aliases: [] },
      caller,
    );
    expectOk(ingredient);
    const ingredientCode = structured(ingredient).id as string;

    const created = await callTool(
      "create_recipe",
      {
        name: "Shortcode Garlic Bread",
        meta: { url: null },
        sections: [
          {
            ingredients: [
              {
                type: "ingredient",
                ingredientId: ingredientCode,
                recipeId: null,
                amounts: [{ value: 2, unit: "clove" }],
              },
            ],
            instructions: [{ instruction: "Mince the garlic." }],
          },
        ],
      },
      caller,
    );
    expectOk(created);
    const createdOut = structured(created);
    expectShortcode(createdOut.id, "recipe");
    const recipeCode = createdOut.id as string;

    const listed = await callTool(
      "list_recipes",
      { nameFilter: "Shortcode Garlic Bread" },
      caller,
    );
    expectOk(listed);
    const items = structured(listed).items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toContain(recipeCode);

    const got = await callTool("get_recipe", { id: recipeCode }, caller);
    expectOk(got);
    // Relationship field resolves: the section's ingredient ref names the
    // ingredient by its public id, not its private uuid (get_recipe's detail
    // shape — recipeOut/recipeDetailMcpOut — is the full section graph).
    const gotOut = structured(got);
    const sections = gotOut.sections as Array<Record<string, unknown>>;
    const firstLine = (sections[0]?.ingredients ?? []) as Array<
      Record<string, unknown>
    >;
    const linkedIngredient = firstLine[0]?.ingredient as
      | Record<string, unknown>
      | undefined;
    expect(linkedIngredient?.id).toBe(ingredientCode);

    const updated = await callTool(
      "update_recipe",
      { id: recipeCode, name: "Shortcode Garlic Bread v2" },
      caller,
    );
    expectOk(updated);
    expect(structured(updated).name).toBe("Shortcode Garlic Bread v2");

    const deleted = await callTool(
      "delete_recipe",
      { ids: [recipeCode] },
      caller,
    );
    expectOk(deleted);
    expect(structured(deleted).deleted).toBe(1);
  });

  it("meal: create with a recipe-shortcode ref -> list -> get -> update -> delete", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const recipe = await callTool(
      "create_recipe",
      { name: "Shortcode Soup", meta: { url: null }, sections: [] },
      caller,
    );
    expectOk(recipe);
    const recipeCode = structured(recipe).id as string;

    const created = await callTool(
      "create_meal",
      {
        date: "2026-08-01",
        name: "Shortcode Dinner",
        recipes: [{ recipeId: recipeCode, scale: 1 }],
      },
      caller,
    );
    expectOk(created);
    const createdOut = structured(created);
    expectShortcode(createdOut.id, "meal");
    const mealCode = createdOut.id as string;
    const recipesOnMeal = createdOut.recipes as Array<Record<string, unknown>>;
    // Relationship field resolves: the planned recipe is named by its public id.
    expect(recipesOnMeal[0]?.recipeId).toBe(recipeCode);
    const mealRecipeId = recipesOnMeal[0]?.id as string;

    const listed = await callTool(
      "list_meals",
      { from: "2026-08-01", to: "2026-08-01" },
      caller,
    );
    expectOk(listed);
    const items = structured(listed).items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toContain(mealCode);

    const got = await callTool("get_meal", { id: mealCode }, caller);
    expectOk(got);
    expect(
      (structured(got).recipes as Array<Record<string, unknown>>)[0]?.recipeId,
    ).toBe(recipeCode);

    const updated = await callTool(
      "update_meal",
      { id: mealCode, name: "Shortcode Dinner Renamed" },
      caller,
    );
    expectOk(updated);
    expect(structured(updated).name).toBe("Shortcode Dinner Renamed");

    // mealRecipe.id is a DECLARED EXCEPTION (no shortcode exists for the join
    // row) — update_meal_recipe/remove_meal_recipe correctly take the raw id.
    const updatedRecipe = await callTool(
      "update_meal_recipe",
      { id: mealRecipeId, scale: 2 },
      caller,
    );
    expectOk(updatedRecipe);

    const deleted = await callTool("delete_meals", { ids: [mealCode] }, caller);
    expectOk(deleted);
    expect(structured(deleted).deleted).toBe(1);
  });

  it("vendor: create -> list -> get -> update (no delete tool by design)", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const created = await callTool(
      "create_vendor",
      { name: "Shortcode Hardware Co" },
      caller,
    );
    expectOk(created);
    const createdOut = structured(created);
    expectShortcode(createdOut.id, "vendor");
    const vendorCode = createdOut.id as string;

    const listed = await callTool(
      "list_vendors",
      { search: "Shortcode Hardware Co" },
      caller,
    );
    expectOk(listed);
    const items = structured(listed).items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toContain(vendorCode);

    const got = await callTool("get_vendor", { id: vendorCode }, caller);
    expectOk(got);
    expect(structured(got).name).toBe("Shortcode Hardware Co");

    const updated = await callTool(
      "update_vendor",
      { id: vendorCode, name: "Shortcode Hardware Co Renamed" },
      caller,
    );
    expectOk(updated);
    expect(structured(updated).name).toBe("Shortcode Hardware Co Renamed");
  });

  it("project: create -> list -> get -> update -> delete, and parentProjectId (relationship field)", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const parent = await callTool(
      "create_project",
      { name: "Shortcode Kitchen Remodel" },
      caller,
    );
    expectOk(parent);
    const parentCode = structured(parent).id as string;

    const child = await callTool(
      "create_project",
      { name: "Shortcode Kitchen Electrical", parentProjectId: parentCode },
      caller,
    );
    expectOk(child);
    const childOut = structured(child);
    expectShortcode(childOut.id, "project");
    // Relationship field resolves: parentProjectId is the PARENT's public id.
    expect(childOut.parentProjectId).toBe(parentCode);
    const childCode = childOut.id as string;

    const listed = await callTool(
      "list_projects",
      { search: "Shortcode Kitchen Electrical" },
      caller,
    );
    expectOk(listed);
    const items = structured(listed).items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toContain(childCode);

    const got = await callTool("get_project", { id: childCode }, caller);
    expectOk(got);
    expect(
      structured(got).parentProjectShortcode ?? structured(got).parentProjectId,
    ).toBe(parentCode);

    const updated = await callTool(
      "update_project",
      { id: childCode, name: "Shortcode Kitchen Electrical Renamed" },
      caller,
    );
    expectOk(updated);
    expect(structured(updated).name).toBe(
      "Shortcode Kitchen Electrical Renamed",
    );

    const deleted = await callTool(
      "delete_projects",
      { ids: [childCode] },
      caller,
    );
    expectOk(deleted);
    expect(structured(deleted).deleted).toBe(1);
  });

  it("task: create -> list -> get -> update -> delete, and projectId/subjectProductId (relationship fields)", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const project = await callTool(
      "create_project",
      { name: "Shortcode Task Project" },
      caller,
    );
    expectOk(project);
    const projectCode = structured(project).id as string;

    const product = await callTool(
      "create_product",
      {
        name: "Shortcode Task Product",
        upc: null,
        manufacturer: "Test Mfg",
        ingredientId: null,
      },
      caller,
    );
    expectOk(product);
    const productCode = structured(product).id as string;

    const created = await callTool(
      "create_task",
      {
        name: "Shortcode Order Countertop",
        trade: "other",
        projectId: projectCode,
        subjectProductId: productCode,
      },
      caller,
    );
    expectOk(created);
    const createdOut = structured(created);
    expectShortcode(createdOut.id, "task");
    // Relationship fields resolve: both FKs are their target's public id.
    expect(createdOut.projectId).toBe(projectCode);
    expect(createdOut.subjectProductId).toBe(productCode);
    const taskCode = createdOut.id as string;

    const listed = await callTool(
      "list_tasks",
      { projectId: projectCode, subjectProductId: productCode },
      caller,
    );
    expectOk(listed);
    const items = structured(listed).items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toContain(taskCode);

    const uuidFilter = await callTool(
      "list_tasks",
      { subjectProductId: "00000000-0000-4000-8000-000000000001" },
      caller,
    );
    expect(uuidFilter.isError).toBe(true);

    const got = await callTool("get_task", { id: taskCode }, caller);
    expectOk(got);
    expect(structured(got).subjectProductId).toBe(productCode);

    const updated = await callTool(
      "update_task",
      { id: taskCode, status: "done" },
      caller,
    );
    expectOk(updated);
    expect(structured(updated).status).toBe("done");

    const deleted = await callTool("delete_tasks", { ids: [taskCode] }, caller);
    expectOk(deleted);
    expect(structured(deleted).deleted).toBe(1);
  });

  it("expense: create -> list -> get -> update -> delete, and projectId/productId (relationship fields)", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const project = await callTool(
      "create_project",
      { name: "Shortcode Expense Project" },
      caller,
    );
    expectOk(project);
    const projectCode = structured(project).id as string;

    const product = await callTool(
      "create_product",
      {
        name: "Shortcode Expense Product",
        upc: null,
        manufacturer: "Test Mfg",
        ingredientId: null,
      },
      caller,
    );
    expectOk(product);
    const productCode = structured(product).id as string;

    const created = await callTool(
      "create_expense",
      {
        name: "Shortcode Miter Saw",
        date: "2024-01-15",
        cost: 249.99,
        costType: "tools",
        trade: "other",
        future: false,
        projectId: projectCode,
        productId: productCode,
      },
      caller,
    );
    expectOk(created);
    const createdOut = structured(created);
    expectShortcode(createdOut.id, "expense");
    expect(createdOut.projectId).toBe(projectCode);
    expect(createdOut.productId).toBe(productCode);
    const expenseCode = createdOut.id as string;

    const listed = await callTool(
      "list_expenses",
      { projectId: projectCode, productId: productCode },
      caller,
    );
    expectOk(listed);
    const items = structured(listed).items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toContain(expenseCode);

    const uuidFilter = await callTool(
      "list_expenses",
      { productId: "00000000-0000-4000-8000-000000000001" },
      caller,
    );
    expect(uuidFilter.isError).toBe(true);

    const got = await callTool("get_expense", { id: expenseCode }, caller);
    expectOk(got);
    expect(structured(got).productId).toBe(productCode);

    const updated = await callTool(
      "update_expense",
      { id: expenseCode, name: "Shortcode Miter Saw Renamed" },
      caller,
    );
    expectOk(updated);
    expect(structured(updated).name).toBe("Shortcode Miter Saw Renamed");

    const deleted = await callTool(
      "delete_expenses",
      { ids: [expenseCode] },
      caller,
    );
    expectOk(deleted);
    expect(structured(deleted)).toMatchObject({
      deleted: 1,
      deletedIds: [expenseCode],
      affectedPurchaseIds: [],
      newlyEmptyPurchaseIds: [],
    });
  });

  it("purchase: create with a vendor shortcode -> list -> get -> update -> delete empty", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const vendor = await callTool(
      "create_vendor",
      { name: "Shortcode Purchase Vendor" },
      caller,
    );
    expectOk(vendor);
    const vendorCode = structured(vendor).id as string;

    // INTENDED CONTRACT: create_purchase's vendorId names the vendor by its
    // public shortcode, same as every other FK field on the MCP boundary.
    const created = await callTool(
      "create_purchase",
      { vendorId: vendorCode, orderId: "SC-0001", date: "2024-01-15" },
      caller,
    );
    expectOk(created);
    const createdOut = structured(created);
    expectShortcode(createdOut.id, "purchase");
    const purchaseCode = createdOut.id as string;

    const listed = await callTool(
      "list_purchases",
      { vendorId: vendorCode },
      caller,
    );
    expectOk(listed);
    const items = structured(listed).items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toContain(purchaseCode);

    const got = await callTool("get_purchase", { id: purchaseCode }, caller);
    expectOk(got);
    expect(got.isError).not.toBe(true);

    const updated = await callTool(
      "update_purchase",
      { id: purchaseCode, notes: "renamed" },
      caller,
    );
    expectOk(updated);

    const deleted = await callTool(
      "delete_empty_purchases",
      { ids: [purchaseCode] },
      caller,
    );
    expectOk(deleted);
    expect(structured(deleted)).toEqual({
      deleted: 1,
      deletedIds: [purchaseCode],
    });
  });

  it("financial account and transaction: create -> list -> get -> update -> delete with account shortcode", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const account = await callTool(
      "create_financial_account",
      {
        name: "Shortcode Settlement Visa",
        identity: {
          kind: "credit_card",
          issuer: "Test Bank",
          network: "visa",
          last4: "4242",
        },
        sourceAliases: [
          {
            source: "shortcode-test",
            alias: "Visa ending 4242",
            externalAccountId: "acct-shortcode-4242",
          },
        ],
      },
      caller,
    );
    expectOk(account);
    const accountOut = structured(account);
    expectShortcode(accountOut.id, "financialAccount");
    const accountCode = accountOut.id as string;

    const listedAccounts = await callTool(
      "list_financial_accounts",
      { search: "Shortcode Settlement Visa" },
      caller,
    );
    expectOk(listedAccounts);
    expect(
      (structured(listedAccounts).items as Array<Record<string, unknown>>).map(
        (item) => item.id,
      ),
    ).toContain(accountCode);

    const gotAccount = await callTool(
      "get_financial_account",
      { id: accountCode },
      caller,
    );
    expectOk(gotAccount);
    expect(structured(gotAccount).name).toBe("Shortcode Settlement Visa");

    const updatedAccount = await callTool(
      "update_financial_account",
      { id: accountCode, notes: "Shortcode account note" },
      caller,
    );
    expectOk(updatedAccount);
    expect(structured(updatedAccount).notes).toBe("Shortcode account note");

    const transaction = await callTool(
      "create_financial_transaction",
      {
        accountId: accountCode,
        kind: "purchase",
        status: "pending",
        amount: 42.5,
        sourceRefs: [
          { source: "shortcode-test", externalId: "transaction-4242" },
        ],
      },
      caller,
    );
    expectOk(transaction);
    const transactionOut = structured(transaction);
    expectShortcode(transactionOut.id, "financialTransaction");
    expect(transactionOut.accountId).toBe(accountCode);
    const transactionCode = transactionOut.id as string;

    const listedTransactions = await callTool(
      "list_financial_transactions",
      { accountId: accountCode },
      caller,
    );
    expectOk(listedTransactions);
    expect(
      (
        structured(listedTransactions).items as Array<Record<string, unknown>>
      ).map((item) => item.id),
    ).toContain(transactionCode);

    const gotTransaction = await callTool(
      "get_financial_transaction",
      { id: transactionCode },
      caller,
    );
    expectOk(gotTransaction);
    expect(structured(gotTransaction).accountId).toBe(accountCode);

    const updatedTransaction = await callTool(
      "update_financial_transaction",
      {
        id: transactionCode,
        status: "posted",
        postedDate: "2026-07-31",
      },
      caller,
    );
    expectOk(updatedTransaction);
    expect(structured(updatedTransaction).status).toBe("posted");

    const duplicateSourceRefs = await callTool(
      "create_financial_transactions",
      {
        items: [
          {
            accountId: accountCode,
            kind: "purchase",
            status: "pending",
            amount: 9.99,
            sourceRefs: [
              {
                source: "shortcode-test",
                externalId: "duplicate-batch-source-ref",
              },
            ],
          },
          {
            accountId: accountCode,
            kind: "purchase",
            status: "pending",
            amount: 10.99,
            sourceRefs: [
              {
                source: "shortcode-test",
                externalId: "duplicate-batch-source-ref",
              },
            ],
          },
        ],
      },
      caller,
    );
    expectOk(duplicateSourceRefs);
    const duplicateBatch = structured(duplicateSourceRefs) as {
      summary: { requested: number; succeeded: number; failed: number };
      results: Array<Record<string, unknown>>;
    };
    expect(duplicateBatch.summary).toEqual({
      requested: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(duplicateBatch.results[0]).toMatchObject({
      index: 0,
      status: "succeeded",
    });
    expect(duplicateBatch.results[1]).toMatchObject({
      index: 1,
      status: "failed",
    });
    const firstBatchResult = duplicateBatch.results[0];
    if (!firstBatchResult?.item) {
      throw new Error(
        "Expected the first duplicate-source batch item to succeed",
      );
    }
    const batchTransactionCode = (
      firstBatchResult.item as Record<string, unknown>
    ).id as string;

    const deletedTransaction = await callTool(
      "delete_financial_transactions",
      { ids: [transactionCode, batchTransactionCode] },
      caller,
    );
    expectOk(deletedTransaction);
    expect(structured(deletedTransaction).deleted).toBe(2);

    const deletedAccount = await callTool(
      "delete_financial_accounts",
      { ids: [accountCode] },
      caller,
    );
    expectOk(deletedAccount);
    expect(structured(deletedAccount).deleted).toBe(1);
  });
});

// 2. A wrong-entity prefix is rejected BEFORE any mutation runs

describe("a wrong-entity shortcode prefix is rejected before any mutation", () => {
  const ctx = withTestDb();

  it("get_product with a LOC- code fails, naming the mismatch", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const location = await callTool(
      "create_location",
      { name: "Wrong Prefix Location", type: "room", parentId: null },
      caller,
    );
    expectOk(location);
    const locationCode = structured(location).id as string;

    const result = await callTool("get_product", { id: locationCode }, caller);
    expect(result.isError).toBe(true);
    // The `PRD-` prefix pattern rejects a `LOC-` code at the Zod input-schema
    // layer, before the domain handler runs.
    expect(errorText(result)).toMatch(/product shortcode/i);
  });

  it("update_location's parentId rejects a PRODUCT code before writing, leaving the row unchanged", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const location = await callTool(
      "create_location",
      { name: "Unchanged Location", type: "room", parentId: null },
      caller,
    );
    expectOk(location);
    const locationCode = structured(location).id as string;

    const product = await callTool(
      "create_product",
      {
        name: "Wrong Prefix Product",
        upc: null,
        manufacturer: "Test Mfg",
        ingredientId: null,
      },
      caller,
    );
    expectOk(product);
    const productCode = structured(product).id as string;

    const rejected = await callTool(
      "update_location",
      { id: locationCode, parentId: productCode },
      caller,
    );
    expect(rejected.isError).toBe(true);
    expect(errorText(rejected)).toContain(productCode);

    // Provably unchanged: the rejection happened before the mutation ran.
    const after = await callTool("get_location", { id: locationCode }, caller);
    expectOk(after);
    expect(structured(after).parentId).toBeNull();
    expect(structured(after).parentName).toBeNull();
  });

  it("create_inventory_entry rejects swapped product/location shortcodes before inserting a row", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const product = await callTool(
      "create_product",
      {
        name: "Swap Test Product",
        upc: null,
        manufacturer: "Test Mfg",
        ingredientId: null,
      },
      caller,
    );
    expectOk(product);
    const productCode = structured(product).id as string;

    const location = await callTool(
      "create_location",
      { name: "Swap Test Location", type: "shelf", parentId: null },
      caller,
    );
    expectOk(location);
    const locationCode = structured(location).id as string;

    const before = await callTool(
      "list_inventory",
      { locationIdFilter: locationCode },
      caller,
    );
    expectOk(before);
    const beforeCount = (structured(before).items as unknown[]).length;

    // productId/locationId swapped — a LOC- code where a PRD- code belongs.
    const rejected = await callTool(
      "create_inventory_entry",
      {
        productId: locationCode,
        locationId: productCode,
        value: 1,
        unit: "each",
      },
      caller,
    );
    expect(rejected.isError).toBe(true);

    const after = await callTool(
      "list_inventory",
      { locationIdFilter: locationCode },
      caller,
    );
    expectOk(after);
    expect((structured(after).items as unknown[]).length).toBe(beforeCount);
  });

  it("delete_locations rejects a PRODUCT shortcode instead of silently deleting nothing or the wrong row", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const product = await callTool(
      "create_product",
      {
        name: "Survives Delete Product",
        upc: null,
        manufacturer: "Test Mfg",
        ingredientId: null,
      },
      caller,
    );
    expectOk(product);
    const productCode = structured(product).id as string;

    const rejected = await callTool(
      "delete_locations",
      { ids: [productCode] },
      caller,
    );
    expect(rejected.isError).toBe(true);

    // The product is provably untouched.
    const got = await callTool("get_product", { id: productCode }, caller);
    expectOk(got);
    expect(structured(got).name).toBe("Survives Delete Product");
  });

  it("merge_ingredients rejects a PRODUCT shortcode as a target before merging anything", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const ingredient = await callTool(
      "create_ingredient",
      { name: "Merge Victim Ingredient", aliases: [] },
      caller,
    );
    expectOk(ingredient);
    const ingredientCode = structured(ingredient).id as string;

    const product = await callTool(
      "create_product",
      {
        name: "Merge Wrong Prefix Product",
        upc: null,
        manufacturer: "Test Mfg",
        ingredientId: null,
      },
      caller,
    );
    expectOk(product);
    const productCode = structured(product).id as string;

    const rejected = await callTool(
      "merge_ingredients",
      { merges: [{ target: productCode, aliases: [ingredientCode] }] },
      caller,
    );
    expect(rejected.isError).toBe(true);

    // The would-be alias survives untouched.
    const stillThere = await callTool(
      "get_ingredient",
      { id: ingredientCode },
      caller,
    );
    expectOk(stillThere);
    expect(structured(stillThere).name).toBe("Merge Victim Ingredient");
  });

  it("merge_vendors rejects a PRODUCT shortcode as keepId before merging anything", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const vendor = await callTool(
      "create_vendor",
      { name: "Merge Victim Vendor" },
      caller,
    );
    expectOk(vendor);
    const vendorCode = structured(vendor).id as string;

    const product = await callTool(
      "create_product",
      {
        name: "Merge Wrong Prefix Product",
        upc: null,
        manufacturer: "Test Mfg",
        ingredientId: null,
      },
      caller,
    );
    expectOk(product);
    const productCode = structured(product).id as string;

    const rejected = await callTool(
      "merge_vendors",
      { keepId: productCode, mergeIds: [vendorCode] },
      caller,
    );
    expect(rejected.isError).toBe(true);

    // The would-be loser survives untouched.
    const stillThere = await callTool("get_vendor", { id: vendorCode }, caller);
    expectOk(stillThere);
    expect(structured(stillThere).name).toBe("Merge Victim Vendor");
  });
});

// 3. Specialized tools round-trip on shortcodes

describe("specialized tools round-trip on shortcodes", () => {
  const ctx = withTestDb();

  it("merge_ingredients folds an alias into a target, addressed entirely by shortcode", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const target = await callTool(
      "create_ingredient",
      { name: "Cilantro", aliases: [] },
      caller,
    );
    expectOk(target);
    const targetCode = structured(target).id as string;

    const alias = await callTool(
      "create_ingredient",
      { name: "Coriander Leaf", aliases: [] },
      caller,
    );
    expectOk(alias);
    const aliasCode = structured(alias).id as string;

    const merged = await callTool(
      "merge_ingredients",
      { merges: [{ target: targetCode, aliases: [aliasCode] }] },
      caller,
    );
    expectOk(merged);
    expect(structured(merged).merged).toBe(1);

    const aliasAfter = await callTool(
      "get_ingredient",
      { id: aliasCode },
      caller,
    );
    expect(aliasAfter.isError).toBe(true);
  });

  it("move_inventory_entries crosses source locations in one call by shortcode", async () => {
    // Boundary contract only — that the tool round-trips shortcodes and that a
    // single call spans more than one source, which `bulk_move_inventory` could
    // not express. The four per-item branches, the merge arithmetic, and the
    // ordering hazards are covered against the repo function in
    // inventory-move-entries.integration.test.ts.
    const caller = createTestCaller(domainRouter, ctx.db);

    const create = async (tool: string, args: Record<string, unknown>) => {
      const created = await callTool(tool, args, caller);
      expectOk(created);
      return structured(created).id as string;
    };

    const widget = await create("create_product", {
      name: "Many Move Widget",
      upc: null,
      manufacturer: "Test Mfg",
      ingredientId: null,
    });
    const shelfA = await create("create_location", {
      name: "Many Move Shelf A",
      type: "shelf",
      parentId: null,
    });
    const shelfB = await create("create_location", {
      name: "Many Move Shelf B",
      type: "shelf",
      parentId: null,
    });
    const drawer = await create("create_location", {
      name: "Many Move Drawer",
      type: "shelf",
      parentId: null,
    });

    const fromA = await create("create_inventory_entry", {
      productId: widget,
      locationId: shelfA,
      value: 4,
      unit: "each",
    });
    const fromB = await create("create_inventory_entry", {
      productId: widget,
      locationId: shelfB,
      value: 6,
      unit: "each",
    });

    const moved = await callTool(
      "move_inventory_entries",
      {
        items: [
          { inventoryEntryId: fromA, targetLocationId: drawer },
          { inventoryEntryId: fromB, targetLocationId: drawer },
        ],
      },
      caller,
    );
    expectOk(moved);

    const listed = await callTool(
      "list_inventory",
      { locationIdFilter: drawer },
      caller,
    );
    expectOk(listed);
    const items = structured(listed).items as Array<Record<string, unknown>>;
    // Both sources collapsed into the one destination row.
    expect(items).toHaveLength(1);
    const row = items[0]!;
    expect((row.amount as { value: number }).value).toBe(10);
    expect((row.location as Record<string, unknown>).id).toBe(drawer);
  });

  it("add_recipe_to_meal plans a recipe by shortcode", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const recipe = await callTool(
      "create_recipe",
      { name: "Add To Meal Recipe", meta: { url: null }, sections: [] },
      caller,
    );
    expectOk(recipe);
    const recipeCode = structured(recipe).id as string;

    const meal = await callTool(
      "create_meal",
      { date: "2026-08-02", name: "Add Recipe Meal" },
      caller,
    );
    expectOk(meal);
    const mealCode = structured(meal).id as string;

    const added = await callTool(
      "add_recipe_to_meal",
      { mealId: mealCode, recipeId: recipeCode, scale: 1 },
      caller,
    );
    expectOk(added);
    const recipesOnMeal = structured(added).recipes as Array<
      Record<string, unknown>
    >;
    expect(recipesOnMeal.some((r) => r.recipeId === recipeCode)).toBe(true);
  });

  it("global_search's hit carries a public id directly usable by get_* (the intended contract)", async () => {
    // A location, not a product — isolates this test from the separate
    // create_product quickCreate double-slim bug documented above.
    const caller = createTestCaller(domainRouter, ctx.db);
    const location = await callTool(
      "create_location",
      { name: "Globally Searchable Shelf", type: "shelf", parentId: null },
      caller,
    );
    expectOk(location);
    const locationCode = structured(location).id as string;

    const searched = await callTool(
      "global_search",
      { query: "Globally Searchable Shelf" },
      caller,
    );
    expectOk(searched);
    const results = structured(searched).results as Array<
      Record<string, unknown>
    >;
    const hit = results.find((r) => r.entityType === "location");
    expect(hit, JSON.stringify(results)).toBeDefined();
    // The docstring promises a way to "turn a name into an id before calling
    // get_*/update_* tools" — under EITHER field name (`id` or `shortcode`,
    // whichever this tool settles on), the value it hands back must be the
    // location's PUBLIC id, directly usable by get_location, not its uuid.
    const navigableId = (hit?.shortcode ?? hit?.id) as string | undefined;
    expect(navigableId).toBe(locationCode);
    const fetched = await callTool(
      "get_location",
      { id: navigableId as string },
      caller,
    );
    expectOk(fetched);
  });

  it("find_similar_entities takes the seed by shortcode (the intended contract)", async () => {
    // An ingredient, not a product — isolates this test from the separate
    // create_product quickCreate double-slim bug documented above.
    const caller = createTestCaller(domainRouter, ctx.db);
    const ingredient = await callTool(
      "create_ingredient",
      { name: "Similarity Seed Ingredient", aliases: [] },
      caller,
    );
    expectOk(ingredient);
    const ingredientCode = structured(ingredient).id as string;

    const result = await callTool(
      "find_similar_entities",
      { pair: "ingredient_to_ingredient", sourceId: ingredientCode },
      caller,
    );
    expectOk(result);
  });

  it("list_problems round-trips: countsOnly and a single-type slice both work against a real caller", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);

    const counts = await callTool(
      "list_problems",
      { countsOnly: true },
      caller,
    );
    expectOk(counts);
    expect(typeof structured(counts).total).toBe("number");

    const slice = await callTool(
      "list_problems",
      { type: "orphanedProducts" },
      caller,
    );
    expectOk(slice);
    expect(structured(slice).type).toBe("orphanedProducts");

    const removedAlias = await callTool(
      "list_problems",
      { type: "chargesNotReconciling" },
      caller,
    );
    expectOk(removedAlias);
    expect(structured(removedAlias).error).toContain("Unknown problem type");
    expect(structured(removedAlias).availableTypes).toContain(
      "purchasesNotReconciling",
    );
  });

  it("split_expense takes its expenseId/projectId/productId by shortcode (the intended contract)", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const vendor = await callTool(
      "create_vendor",
      { name: "Split Expense Vendor" },
      caller,
    );
    expectOk(vendor);
    const vendorCode = structured(vendor).id as string;

    const purchase = await callTool(
      "create_purchase",
      { vendorId: vendorCode, date: "2024-01-15" },
      caller,
    );
    expectOk(purchase);

    const expense = await callTool(
      "create_expense",
      {
        name: "Combo Kit",
        date: "2024-01-15",
        cost: 100,
        costType: "tools",
        trade: "other",
        future: false,
        vendor: "Split Expense Vendor",
      },
      caller,
    );
    expectOk(expense);
    const expenseCode = structured(expense).id as string;

    const split = await callTool(
      "split_expense",
      {
        expenseId: expenseCode,
        parts: [
          { name: "Saw", cost: 80, costType: "tools", trade: "other" },
          { name: "Blade", cost: 20, costType: "tools", trade: "other" },
        ],
      },
      caller,
    );
    expectOk(split);
  });

  it("merge_purchases takes keepId/mergeIds by shortcode (the intended contract)", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const vendor = await callTool(
      "create_vendor",
      { name: "Merge Purchases Vendor" },
      caller,
    );
    expectOk(vendor);
    const vendorCode = structured(vendor).id as string;

    const keep = await callTool(
      "create_purchase",
      { vendorId: vendorCode, date: "2024-01-15" },
      caller,
    );
    expectOk(keep);
    const keepCode = structured(keep).id as string;

    const loser = await callTool(
      "create_purchase",
      { vendorId: vendorCode, date: "2024-01-15" },
      caller,
    );
    expectOk(loser);
    const loserCode = structured(loser).id as string;

    const merged = await callTool(
      "merge_purchases",
      { keepId: keepCode, mergeIds: [loserCode] },
      caller,
    );
    expectOk(merged);
    expect(structured(merged).id).toBe(keepCode);
  });

  it("merge_vendors takes keepId/mergeIds by shortcode and tombstones the loser's own code", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const keep = await callTool(
      "create_vendor",
      { name: "Merge Vendors Keeper" },
      caller,
    );
    expectOk(keep);
    const keepCode = structured(keep).id as string;

    const loser = await callTool(
      "create_vendor",
      { name: "Merge Vendors Loser" },
      caller,
    );
    expectOk(loser);
    const loserCode = structured(loser).id as string;

    const merged = await callTool(
      "merge_vendors",
      { keepId: keepCode, mergeIds: [loserCode] },
      caller,
    );
    expectOk(merged);
    expect(structured(merged).id).toBe(keepCode);

    // The loser's code is a permanent tombstone — it resolves to nothing, not
    // to the keeper.
    const loserAfter = await callTool("get_vendor", { id: loserCode }, caller);
    expect(loserAfter.isError).toBe(true);
  });

  it("link_expenses_to_purchase takes purchaseId/expenseIds by shortcode (the intended contract)", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const vendor = await callTool(
      "create_vendor",
      { name: "Link Expenses Vendor" },
      caller,
    );
    expectOk(vendor);
    const vendorCode = structured(vendor).id as string;

    const purchase = await callTool(
      "create_purchase",
      { vendorId: vendorCode, date: "2024-01-15" },
      caller,
    );
    expectOk(purchase);
    const purchaseCode = structured(purchase).id as string;

    const expense = await callTool(
      "create_expense",
      {
        name: "Unlinked line",
        date: "2024-01-15",
        cost: 42,
        costType: "materials",
        trade: "other",
        future: false,
      },
      caller,
    );
    expectOk(expense);
    const expenseCode = structured(expense).id as string;

    const linked = await callTool(
      "link_expenses_to_purchase",
      { purchaseId: purchaseCode, expenseIds: [expenseCode] },
      caller,
    );
    expectOk(linked);
  });

  it("update_tasks moves tasks onto a project by shortcode", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const project = await callTool(
      "create_project",
      { name: "Bulk Move Tasks Project" },
      caller,
    );
    expectOk(project);
    const projectCode = structured(project).id as string;

    const task = await callTool(
      "create_task",
      { name: "Bulk Move Task", trade: "other" },
      caller,
    );
    expectOk(task);
    const taskCode = structured(task).id as string;

    const moved = await callTool(
      "update_tasks",
      { items: [{ id: taskCode, projectId: projectCode }] },
      caller,
    );
    expectOk(moved);
    const results = structured(moved).results as Array<Record<string, unknown>>;
    expect((results[0]?.item as Record<string, unknown>)?.projectId).toBe(
      projectCode,
    );
  });
});

// 4. Schema walk: no OUTPUT schema exposes a uuid-shaped id outside the
//    declared exceptions, driven off the live tool catalog.

type JsonSchemaNode = Record<string, unknown>;

interface UuidFinding {
  tool: string;
  path: string;
  field: string;
  siblings: string[];
}

/** Exact permanent UUID exceptions. A newly exposed UUID must be named here
 * deliberately; field-name heuristics are intentionally not accepted. */
const DECLARED_UUID_OUTPUT_PATHS = new Set([
  "add_recipe_to_meal.recipes[].id",
  "attach_file.imageId",
  "get_product.images[].id",
  "patch_product_external_ids.images[].id",
  "create_meal.recipes[].id",
  "find_recipes_using_ingredient.recipes[].usages[].lineId",
  "get_meal.recipes[].id",
  "get_recipe.images[].id",
  "get_recipe.sections[].id",
  "get_recipe.sections[].ingredients[].id",
  "list_meals.items[].recipes[].id",
  "remove_meal_recipe.recipes[].id",
  "update_meal.recipes[].id",
  "update_meal_recipe.recipes[].id",
  "verify_product_images.images[].id",
  // Plural mirrors of the singular exceptions above. A batch tool wraps its
  // singular's own output in `results[].item`, so it re-exposes exactly the
  // same declared-uuid leaves — image ids and the mealRecipe row id, neither of
  // which has a shortcode.
  "attach_files.results[].item.imageId",
  "create_meals.results[].item.recipes[].id",
  "update_meals.results[].item.recipes[].id",
  "patch_products_external_ids.results[].item.images[].id",
  "verify_products_images.results[].item.images[].id",
  // The staged-upload handle. It IS an Image id, and images are a declared
  // exception with no shortcode — the caller hands this straight back to
  // attach_file, so it is the identifier rather than a leaked internal.
  "create_file_upload.uploadId",
]);

const NOT_YET_CUT_OVER: string[] = [];

/** Recursively walk a JSON Schema (draft-7, as advertised by `tools/list`),
 * resolving `$ref`/`$defs` and `anyOf`/`oneOf`/`allOf` branches, collecting
 * every leaf typed `{format: "uuid"}` — the signature `z.uuid()` (and every
 * branded id built on it, see `identifiers.ts`'s `brandedId`) leaves in the
 * advertised schema. */
function collectUuidFindings(
  node: unknown,
  defs: Record<string, JsonSchemaNode>,
  toolName: string,
  path: string,
  visited: Set<unknown>,
  out: UuidFinding[],
) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  if (visited.has(node)) return;
  visited.add(node);
  const schema = node as JsonSchemaNode;

  if (typeof schema.$ref === "string") {
    const refName = schema.$ref.split("/").pop();
    const target = refName ? defs[refName] : undefined;
    if (target) collectUuidFindings(target, defs, toolName, path, visited, out);
    return;
  }

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        collectUuidFindings(branch, defs, toolName, path, visited, out);
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    collectUuidFindings(
      schema.items,
      defs,
      toolName,
      `${path}[]`,
      visited,
      out,
    );
  }

  const properties = schema.properties as
    | Record<string, JsonSchemaNode>
    | undefined;
  if (properties) {
    const siblings = Object.keys(properties);
    for (const [field, value] of Object.entries(properties)) {
      if (!value || typeof value !== "object") continue;
      if (value.format === "uuid") {
        out.push({ tool: toolName, path: `${path}.${field}`, field, siblings });
      }
      collectUuidFindings(
        value,
        defs,
        toolName,
        `${path}.${field}`,
        visited,
        out,
      );
    }
  }
}

describe("MCP output schemas expose shortcodes, not uuids, outside declared exceptions", () => {
  it("walks every registered tool's OUTPUT schema off the live catalog", async () => {
    const { tools } = await listMcpToolCatalog();
    expect(tools.length).toBeGreaterThan(50);

    const violations: UuidFinding[] = [];
    for (const tool of tools) {
      const outputSchema = tool.outputSchema as JsonSchemaNode | undefined;
      if (!outputSchema) continue;
      const defs =
        (outputSchema.$defs as Record<string, JsonSchemaNode> | undefined) ??
        (outputSchema.definitions as
          | Record<string, JsonSchemaNode>
          | undefined) ??
        {};
      const found: UuidFinding[] = [];
      collectUuidFindings(
        outputSchema,
        defs,
        tool.name,
        tool.name,
        new Set(),
        found,
      );
      violations.push(
        ...found.filter((f) => !DECLARED_UUID_OUTPUT_PATHS.has(f.path)),
      );
    }

    // Asserted as an EXACT set, not a subset: a new leak fails here, and so
    // does fixing one without striking it off the backlog. That keeps the list
    // shrinking rather than quietly becoming a permanent allowlist.
    expect(
      violations.map((v) => v.path).sort(),
      `uuid-shaped output fields changed.\nAdded (fix or declare):\n${violations
        .map(
          (v) => `  ${v.tool}: ${v.path} (siblings: ${v.siblings.join(", ")})`,
        )
        .join("\n")}`,
    ).toEqual([...NOT_YET_CUT_OVER].sort());
  });
});

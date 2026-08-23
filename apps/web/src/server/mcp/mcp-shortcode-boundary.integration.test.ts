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
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { DomainCaller } from "~/server/api/domain";
import { domainRouter } from "~/server/api/domain";
import { createTestCaller } from "~/server/api/trpc";
import { createMcpServer } from "./server";

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

  /** Create through a tool and hand back the public id it minted. */
  async function createCode(
    caller: DomainCaller,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await callTool(tool, args, caller);
    expectOk(result);
    return structured(result).id as string;
  }

  /** Shortcodes minted by a row's `setup`, keyed by role. */
  type Bag = Record<string, string>;
  /** Which tool output a check runs against. */
  type Phase = "create" | "get" | "update";
  /** A dotted path into an output (array indices allowed), or a reader. */
  type FieldPath = string | ((out: Record<string, unknown>) => unknown);
  /** `[path, expected, ...phases]` — phases default to the create output. */
  type FieldCheck = [FieldPath, unknown, ...Phase[]];

  function readPath(out: Record<string, unknown>, path: FieldPath): unknown {
    if (typeof path === "function") return path(out);
    return path
      .split(".")
      .reduce<unknown>(
        (acc, key) => (acc as Record<string, unknown> | undefined)?.[key],
        out,
      );
  }

  function runChecks(
    out: Record<string, unknown>,
    checks: FieldCheck[],
    phase: Phase,
  ) {
    for (const [path, expected, ...phases] of checks) {
      if (!(phases.length ? phases : ["create"]).includes(phase)) continue;
      const label = typeof path === "string" ? path : "(reader)";
      expect(readPath(out, path), `${phase}: ${label}`).toEqual(expected);
    }
  }

  interface RoundTrip {
    /** The entity every minted id must be stamped for, and the test's name. */
    entity: string;
    /** Tool names in lifecycle order: `create list get update [delete]`. */
    tools: string;
    /** Prerequisite entities; everything below closes over the codes it returns. */
    setup?: (caller: DomainCaller) => Promise<Bag>;
    createArgs: (bag: Bag) => Record<string, unknown>;
    listArgs: (bag: Bag) => Record<string, unknown>;
    /** Exact result count, where the filter is precise enough to pin one. */
    expectListLength?: number;
    /** A filter the list tool must REJECT (a raw uuid where a code belongs). */
    rejectsListArgs?: Record<string, unknown>;
    /** Merged with `{ id }`. */
    updateArgs: Record<string, unknown>;
    /** Relationship round-trips and field assertions, per phase. */
    checks?: (bag: Bag) => FieldCheck[];
    /** Anything that doesn't fit the skeleton; runs after update. */
    extraChecks?: (args: {
      caller: DomainCaller;
      createdOut: Record<string, unknown>;
      code: string;
      bag: Bag;
    }) => Promise<void>;
    /** Defaults to `deleted === 1`. */
    checkDelete?: (out: Record<string, unknown>, code: string) => void;
    /** Whether `get` must error once the row is gone. */
    getFailsAfterDelete?: boolean;
  }

  function toolsOf(row: RoundTrip) {
    const [create, list, get, update, remove] = row.tools.split(" ");
    if (!create || !list || !get || !update) {
      throw new Error(`Malformed tool lifecycle for ${row.entity}`);
    }
    return { create, list, get, update, remove };
  }

  const financialAccountArgs = (name: string, last4: string) => ({
    name,
    identity: {
      kind: "credit_card",
      issuer: "Test Bank",
      network: "visa",
      last4,
    },
    sourceAliases: [
      {
        source: "shortcode-test",
        alias: `Visa ending ${last4}`,
        externalAccountId: `acct-shortcode-${last4}`,
      },
    ],
  });

  const productArgs = (name: string) => ({
    name,
    upc: null,
    manufacturer: "Test Mfg",
    ingredientId: null,
  });

  /**
   * One row per MCP-exposed entity: its lifecycle tools, the prerequisite
   * entities `setup` mints, the args each step sends, and the field checks that
   * pin every id crossing the boundary to a public shortcode. The shared body
   * below runs create -> list -> get -> update -> delete and asserts the
   * shortcode survives the update unchanged. A newly MCP-exposed entity belongs
   * here as one more row.
   */
  const roundTrips: RoundTrip[] = [
    {
      entity: "location",
      tools:
        "create_location list_locations get_location update_location delete_locations",
      setup: async (caller) => ({
        parent: await createCode(caller, "create_location", {
          name: "Shortcode Pantry",
          type: "room",
          parentId: null,
        }),
      }),
      createArgs: (bag) => ({
        name: "Shortcode Shelf",
        type: "shelf",
        parentId: bag.parent,
      }),
      listArgs: () => ({ nameFilter: "Shortcode Shelf" }),
      expectListLength: 1,
      updateArgs: { name: "Shortcode Shelf Renamed" },
      checks: (bag) => [
        // parentId round-trips to the PARENT's public id, not its uuid.
        ["parentId", bag.parent, "create", "get"],
        ["parentName", "Shortcode Pantry", "get"],
        ["name", "Shortcode Shelf Renamed", "update"],
      ],
      getFailsAfterDelete: true,
    },
    {
      entity: "ingredient",
      tools:
        "create_ingredient search_ingredients get_ingredient update_ingredient delete_ingredients",
      createArgs: () => ({ name: "Shortcode Basil", aliases: ["sweet basil"] }),
      listArgs: () => ({ nameFilter: "Shortcode Basil" }),
      updateArgs: { name: "Shortcode Basil Renamed" },
      checks: () => [
        ["name", "Shortcode Basil", "get"],
        ["name", "Shortcode Basil Renamed", "update"],
      ],
    },
    {
      entity: "product",
      tools:
        "create_product search_products get_product update_product delete_products",
      setup: async (caller) => ({
        ingredient: await createCode(caller, "create_ingredient", {
          name: "Shortcode Flour",
          aliases: [],
        }),
      }),
      createArgs: (bag) => ({
        ...productArgs("Shortcode Flour 5lb Bag"),
        ingredientId: bag.ingredient,
      }),
      listArgs: () => ({ nameFilter: "Shortcode Flour 5lb Bag" }),
      updateArgs: { name: "Shortcode Flour 5lb Bag v2" },
      checks: (bag) => [
        ["ingredientId", bag.ingredient, "create", "get"],
        ["name", "Shortcode Flour 5lb Bag v2", "update"],
      ],
    },
    {
      entity: "inventory",
      tools:
        "create_inventory_entry list_inventory get_inventory_entry update_inventory_entry delete_inventory_entries",
      setup: async (caller) => ({
        product: await createCode(
          caller,
          "create_product",
          productArgs("Shortcode Canned Beans"),
        ),
        location: await createCode(caller, "create_location", {
          name: "Shortcode Cupboard",
          type: "shelf",
          parentId: null,
        }),
      }),
      createArgs: (bag) => ({
        productId: bag.product,
        locationId: bag.location,
        value: 3,
        unit: "each",
      }),
      listArgs: (bag) => ({ locationIdFilter: bag.location }),
      updateArgs: { value: 5, unit: "each" },
      checks: (bag) => [
        ["product.id", bag.product, "create", "get"],
        ["location.id", bag.location, "create"],
        ["amount", { value: 5, unit: "each" }, "update"],
      ],
    },
    {
      entity: "recipe",
      tools:
        "create_recipe list_recipes get_recipe update_recipe delete_recipe",
      setup: async (caller) => ({
        ingredient: await createCode(caller, "create_ingredient", {
          name: "Shortcode Garlic",
          aliases: [],
        }),
      }),
      createArgs: (bag) => ({
        name: "Shortcode Garlic Bread",
        meta: { url: null },
        sections: [
          {
            ingredients: [
              {
                type: "ingredient",
                ingredientId: bag.ingredient,
                recipeId: null,
                amounts: [{ value: 2, unit: "clove" }],
              },
            ],
            instructions: [{ instruction: "Mince the garlic." }],
          },
        ],
      }),
      listArgs: () => ({ nameFilter: "Shortcode Garlic Bread" }),
      updateArgs: { name: "Shortcode Garlic Bread v2" },
      checks: (bag) => [
        // get_recipe's detail shape is the full section graph, and the
        // section's ingredient ref names the ingredient by its public id.
        ["sections.0.ingredients.0.ingredient.id", bag.ingredient, "get"],
        ["name", "Shortcode Garlic Bread v2", "update"],
      ],
    },
    {
      entity: "meal",
      tools: "create_meal list_meals get_meal update_meal delete_meals",
      setup: async (caller) => ({
        recipe: await createCode(caller, "create_recipe", {
          name: "Shortcode Soup",
          meta: { url: null },
          sections: [],
        }),
      }),
      createArgs: (bag) => ({
        date: "2026-08-01",
        name: "Shortcode Dinner",
        recipes: [{ recipeId: bag.recipe, scale: 1 }],
      }),
      listArgs: () => ({ from: "2026-08-01", to: "2026-08-01" }),
      updateArgs: { name: "Shortcode Dinner Renamed" },
      checks: (bag) => [
        ["recipes.0.recipeId", bag.recipe, "create", "get"],
        ["name", "Shortcode Dinner Renamed", "update"],
      ],
      extraChecks: async ({ caller, createdOut }) => {
        // mealRecipe.id is a DECLARED EXCEPTION (no shortcode exists for the
        // join row) — update_meal_recipe correctly takes the raw id.
        const mealRecipeId = (
          createdOut.recipes as Array<Record<string, unknown>>
        )[0]?.id as string;
        expectOk(
          await callTool(
            "update_meal_recipe",
            { id: mealRecipeId, scale: 2 },
            caller,
          ),
        );
      },
    },
    {
      entity: "vendor",
      // Four tools, not five: vendors have NO delete tool BY DESIGN. The
      // missing lifecycle step is deliberate, not an oversight.
      tools: "create_vendor list_vendors get_vendor update_vendor",
      createArgs: () => ({ name: "Shortcode Hardware Co" }),
      listArgs: () => ({ search: "Shortcode Hardware Co" }),
      updateArgs: { name: "Shortcode Hardware Co Renamed" },
      checks: () => [
        ["name", "Shortcode Hardware Co", "get"],
        ["name", "Shortcode Hardware Co Renamed", "update"],
      ],
    },
    {
      entity: "project",
      tools:
        "create_project list_projects get_project update_project delete_projects",
      setup: async (caller) => ({
        parent: await createCode(caller, "create_project", {
          name: "Shortcode Kitchen Remodel",
        }),
      }),
      createArgs: (bag) => ({
        name: "Shortcode Kitchen Electrical",
        parentProjectId: bag.parent,
      }),
      listArgs: () => ({ search: "Shortcode Kitchen Electrical" }),
      updateArgs: { name: "Shortcode Kitchen Electrical Renamed" },
      checks: (bag) => [
        ["parentProjectId", bag.parent],
        [
          (out) => out.parentProjectShortcode ?? out.parentProjectId,
          bag.parent,
          "get",
        ],
        ["name", "Shortcode Kitchen Electrical Renamed", "update"],
      ],
    },
    {
      entity: "task",
      tools: "create_task list_tasks get_task update_task delete_tasks",
      setup: async (caller) => ({
        project: await createCode(caller, "create_project", {
          name: "Shortcode Task Project",
        }),
        product: await createCode(
          caller,
          "create_product",
          productArgs("Shortcode Task Product"),
        ),
      }),
      createArgs: (bag) => ({
        name: "Shortcode Order Countertop",
        trade: "other",
        projectId: bag.project,
        subjectProductId: bag.product,
      }),
      listArgs: (bag) => ({
        projectId: bag.project,
        subjectProductId: bag.product,
      }),
      rejectsListArgs: {
        subjectProductId: "00000000-0000-4000-8000-000000000001",
      },
      updateArgs: { status: "done" },
      checks: (bag) => [
        ["projectId", bag.project],
        ["subjectProductId", bag.product, "create", "get"],
        ["status", "done", "update"],
      ],
    },
    {
      entity: "expense",
      tools:
        "create_expense list_expenses get_expense update_expense delete_expenses",
      setup: async (caller) => ({
        project: await createCode(caller, "create_project", {
          name: "Shortcode Expense Project",
        }),
        product: await createCode(
          caller,
          "create_product",
          productArgs("Shortcode Expense Product"),
        ),
      }),
      createArgs: (bag) => ({
        name: "Shortcode Miter Saw",
        date: "2024-01-15",
        cost: 249.99,
        costType: "tools",
        trade: "other",
        future: false,
        projectId: bag.project,
        productId: bag.product,
      }),
      listArgs: (bag) => ({ projectId: bag.project, productId: bag.product }),
      rejectsListArgs: { productId: "00000000-0000-4000-8000-000000000001" },
      updateArgs: { name: "Shortcode Miter Saw Renamed" },
      checks: (bag) => [
        ["projectId", bag.project],
        ["productId", bag.product, "create", "get"],
        ["name", "Shortcode Miter Saw Renamed", "update"],
      ],
      // The purchase consequences are `sideEffects` now, not top-level fields:
      // they are things the delete CHANGED, not a different kind of result.
      // Empty here because this expense has no purchase behind it.
      checkDelete: (out, code) =>
        expect(out).toMatchObject({
          deleted: 1,
          deletedIds: [code],
          sideEffects: [],
        }),
    },
    {
      entity: "purchase",
      tools:
        "create_purchase list_purchases get_purchase update_purchase delete_empty_purchases",
      setup: async (caller) => ({
        vendor: await createCode(caller, "create_vendor", {
          name: "Shortcode Purchase Vendor",
        }),
      }),
      // INTENDED CONTRACT: create_purchase's vendorId names the vendor by its
      // public shortcode, same as every other FK field on the MCP boundary.
      createArgs: (bag) => ({
        vendorId: bag.vendor,
        orderId: "SC-0001",
        date: "2024-01-15",
      }),
      listArgs: (bag) => ({ vendorId: bag.vendor }),
      updateArgs: { notes: "renamed" },
      // `deleteEmpty` reports a measured count; it does not echo the ids back.
      checkDelete: (out) =>
        expect(out).toEqual({ deleted: 1, sideEffects: [] }),
    },
    {
      entity: "financialAccount",
      tools:
        "create_financial_account list_financial_accounts get_financial_account update_financial_account delete_financial_accounts",
      createArgs: () =>
        financialAccountArgs("Shortcode Settlement Visa", "4242"),
      listArgs: () => ({ search: "Shortcode Settlement Visa" }),
      updateArgs: { notes: "Shortcode account note" },
      checks: () => [
        ["name", "Shortcode Settlement Visa", "get"],
        ["notes", "Shortcode account note", "update"],
      ],
    },
    {
      entity: "financialTransaction",
      tools:
        "create_financial_transaction list_financial_transactions get_financial_transaction update_financial_transaction delete_financial_transactions",
      setup: async (caller) => ({
        account: await createCode(
          caller,
          "create_financial_account",
          financialAccountArgs("Shortcode Settlement Visa", "4242"),
        ),
      }),
      createArgs: (bag) => ({
        accountId: bag.account,
        kind: "purchase",
        status: "pending",
        amount: 42.5,
        sourceRefs: [
          { source: "shortcode-test", externalId: "transaction-4242" },
        ],
      }),
      listArgs: (bag) => ({ accountId: bag.account }),
      updateArgs: { status: "posted", postedDate: "2026-07-31" },
      checks: (bag) => [
        ["accountId", bag.account, "create", "get"],
        ["status", "posted", "update"],
      ],
    },
  ];

  it.each(roundTrips)(
    "$entity: create -> list -> get -> update -> delete, on shortcodes only",
    async (row) => {
      const caller = createTestCaller(domainRouter, ctx.db);
      const tools = toolsOf(row);
      const bag = (await row.setup?.(caller)) ?? {};
      const checks = row.checks?.(bag) ?? [];

      const created = await callTool(tools.create, row.createArgs(bag), caller);
      expectOk(created);
      const createdOut = structured(created);
      expectShortcode(createdOut.id, row.entity);
      const code = createdOut.id as string;
      runChecks(createdOut, checks, "create");

      const listed = await callTool(tools.list, row.listArgs(bag), caller);
      expectOk(listed);
      const items = structured(listed).items as Array<Record<string, unknown>>;
      if (row.expectListLength !== undefined) {
        expect(items).toHaveLength(row.expectListLength);
      }
      expect(items.map((item) => item.id)).toContain(code);

      if (row.rejectsListArgs) {
        const rejected = await callTool(
          tools.list,
          row.rejectsListArgs,
          caller,
        );
        expect(rejected.isError).toBe(true);
      }

      const got = await callTool(tools.get, { id: code }, caller);
      expectOk(got);
      runChecks(structured(got), checks, "get");

      const updated = await callTool(
        tools.update,
        { id: code, ...row.updateArgs },
        caller,
      );
      expectOk(updated);
      const updatedOut = structured(updated);
      // The shortcode never changes across an update.
      expect(updatedOut.id).toBe(code);
      runChecks(updatedOut, checks, "update");

      await row.extraChecks?.({ caller, createdOut, code, bag });

      if (!tools.remove) return;
      // One `delete_entity` for every entity — the per-entity delete tools are
      // gone. `tools.remove` now only says whether this entity is deletable.
      const deleted = await callTool(
        "delete_entity",
        { entity: row.entity, ids: [code] },
        caller,
      );
      expectOk(deleted);
      const deletedOut = structured(deleted);
      if (row.checkDelete) row.checkDelete(deletedOut, code);
      else expect(deletedOut.deleted).toBe(1);

      if (row.getFailsAfterDelete) {
        const afterDelete = await callTool(tools.get, { id: code }, caller);
        expect(afterDelete.isError).toBe(true);
      }
    },
  );

  // Batch create has its own shape — a per-item result envelope rather than one
  // row — so it stays beside the table instead of contorting a column into it.
  it("financial transactions: a duplicate sourceRef inside one batch fails only that item", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const accountCode = await createCode(
      caller,
      "create_financial_account",
      financialAccountArgs("Shortcode Settlement Visa", "4242"),
    );
    const transactionCode = await createCode(
      caller,
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
    );

    const duplicateSourceRefs = await callTool(
      "create_financial_transactions",
      {
        items: [9.99, 10.99].map((amount) => ({
          accountId: accountCode,
          kind: "purchase",
          status: "pending",
          amount,
          sourceRefs: [
            {
              source: "shortcode-test",
              externalId: "duplicate-batch-source-ref",
            },
          ],
        })),
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
    // The compact default carries the shortcode directly, which is the whole
    // reason it is the default: a batch caller needs the ids, not the entities.
    const batchTransactionCode = duplicateBatch.results[0]?.id;
    if (typeof batchTransactionCode !== "string") {
      throw new Error(
        "Expected the first duplicate-source batch item to succeed",
      );
    }

    const deleted = await callTool(
      "delete_entity",
      {
        entity: "financialTransaction",
        ids: [transactionCode, batchTransactionCode],
      },
      caller,
    );
    expectOk(deleted);
    expect(structured(deleted).deleted).toBe(2);
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
    expect(structured(after).parentId).toBe(TEST_HOME_SHORTCODE);
    expect(structured(after).parentName).toBe("Home");
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

  it("delete_entity rejects a PRODUCT shortcode for entity=location instead of silently deleting nothing or the wrong row", async () => {
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
      "delete_entity",
      // A PRD- code under entity=location: rejected on the prefix, never routed
      // to the wrong table.
      { entity: "location", ids: [productCode] },
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
    expect(
      (structured(merged).summary as { succeeded: number }).succeeded,
    ).toBe(1);

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
    // `{ vendor, mergeSummary }` — the merge now reports what it moved.
    expect((structured(merged) as { vendor: { id: string } }).vendor.id).toBe(
      keepCode,
    );

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
      // `resultDetail: "full"` because this asserts on the written entity, not
      // just on the id the compact default returns.
      {
        items: [{ id: taskCode, projectId: projectCode }],
        resultDetail: "full",
      },
      caller,
    );
    expectOk(moved);
    const results = structured(moved).results as Array<Record<string, unknown>>;
    expect((results[0]?.item as Record<string, unknown>)?.projectId).toBe(
      projectCode,
    );
  });
});

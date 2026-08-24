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

/**
 * Call a plural batch create/update tool (`create_xs`/`update_xs`) with
 * exactly one item and hand back the same shape the retired singular tool
 * (`create_x`/`update_x`) used to return, so every call site here can keep
 * reading the entity's own fields off `structuredContent` directly instead of
 * unwrapping a batch envelope. The singular tools were dropped because the
 * plural ones accept a one-item array and made them strictly redundant — see
 * `registerEntityCrudToolset` in tools/_shared.ts.
 */
async function callSingular(
  tool: string,
  args: Record<string, unknown>,
  caller: DomainCaller,
): Promise<CallToolResult> {
  const result = await callTool(
    tool,
    { items: [args], resultDetail: "full" },
    caller,
  );
  if (result.isError) return result;
  const { results } = structured(result) as {
    results: Array<Record<string, unknown>>;
  };
  const [only] = results;
  if (only?.status === "failed") {
    return {
      ...result,
      isError: true,
      structuredContent: only,
      content: [{ type: "text" as const, text: JSON.stringify(only) }],
    };
  }
  return {
    ...result,
    structuredContent: only?.item as Record<string, unknown> | undefined,
  };
}

// 1. list -> create -> get -> update -> delete round trips, per entity

describe("MCP CRUD round trips are driven by shortcodes only", () => {
  const ctx = withTestDb();

  /**
   * Create through a batch tool's plural name (`create_xs`) with one item and
   * hand back the public id it minted.
   */
  async function createCode(
    caller: DomainCaller,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await callSingular(tool, args, caller);
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
    /**
     * Tool names in lifecycle order: `create list get update [delete]`.
     * `create`/`update` name the PLURAL batch tools (`create_xs`/`update_xs`)
     * — the singular ones have no twin of their own anymore — and the
     * generic body below drives them through `callSingular` with one item.
     */
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
        "create_locations list_locations get_location update_locations delete_locations",
      setup: async (caller) => ({
        parent: await createCode(caller, "create_locations", {
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
        // The parent round-trips as a nested ref keyed by the PARENT's public
        // id, not its uuid.
        ["parent.id", bag.parent, "create", "get"],
        ["parent.name", "Shortcode Pantry", "get"],
        ["name", "Shortcode Shelf Renamed", "update"],
      ],
      getFailsAfterDelete: true,
    },
    {
      entity: "ingredient",
      tools:
        "create_ingredients search_ingredients get_ingredient update_ingredients delete_ingredients",
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
        "create_products search_products get_product update_products delete_products",
      setup: async (caller) => ({
        ingredient: await createCode(caller, "create_ingredients", {
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
        "create_inventory_entries list_inventory get_inventory_entry update_inventory_entries delete_inventory_entries",
      setup: async (caller) => ({
        product: await createCode(
          caller,
          "create_products",
          productArgs("Shortcode Canned Beans"),
        ),
        location: await createCode(caller, "create_locations", {
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
        "create_recipes list_recipes get_recipe update_recipes delete_recipe",
      setup: async (caller) => ({
        ingredient: await createCode(caller, "create_ingredients", {
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
      tools: "create_meals list_meals get_meal update_meals delete_meals",
      setup: async (caller) => ({
        recipe: await createCode(caller, "create_recipes", {
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
      tools: "create_vendors list_vendors get_vendor update_vendors",
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
        "create_projects list_projects get_project update_projects delete_projects",
      setup: async (caller) => ({
        parent: await createCode(caller, "create_projects", {
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
      tools: "create_tasks list_tasks get_task update_tasks delete_tasks",
      setup: async (caller) => ({
        project: await createCode(caller, "create_projects", {
          name: "Shortcode Task Project",
        }),
        product: await createCode(
          caller,
          "create_products",
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
        "create_expenses list_expenses get_expense update_expenses delete_expenses",
      setup: async (caller) => ({
        project: await createCode(caller, "create_projects", {
          name: "Shortcode Expense Project",
        }),
        product: await createCode(
          caller,
          "create_products",
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
        "create_purchases list_purchases get_purchase update_purchases delete_empty_purchases",
      setup: async (caller) => ({
        vendor: await createCode(caller, "create_vendors", {
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
        "create_financial_accounts list_financial_accounts get_financial_account update_financial_accounts delete_financial_accounts",
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
        "create_financial_transactions list_financial_transactions get_financial_transaction update_financial_transactions delete_financial_transactions",
      setup: async (caller) => ({
        account: await createCode(
          caller,
          "create_financial_accounts",
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

      // `tools.create` names the plural batch tool (create_x has no singular
      // twin anymore); `callSingular` sends the one item and unwraps the
      // result back to the shape the retired singular tool used to return.
      const created = await callSingular(
        tools.create,
        row.createArgs(bag),
        caller,
      );
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

      const updated = await callSingular(
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
      "create_financial_accounts",
      financialAccountArgs("Shortcode Settlement Visa", "4242"),
    );
    const transactionCode = await createCode(
      caller,
      "create_financial_transactions",
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
    const location = await callSingular(
      "create_locations",
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
    const location = await callSingular(
      "create_locations",
      { name: "Unchanged Location", type: "room", parentId: null },
      caller,
    );
    expectOk(location);
    const locationCode = structured(location).id as string;

    const product = await callSingular(
      "create_products",
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

    const rejected = await callSingular(
      "update_locations",
      { id: locationCode, parentId: productCode },
      caller,
    );
    expect(rejected.isError).toBe(true);
    expect(errorText(rejected)).toContain(productCode);

    // Provably unchanged: the rejection happened before the mutation ran.
    const after = await callTool("get_location", { id: locationCode }, caller);
    expectOk(after);
    expect(structured(after).parent).toMatchObject({
      id: TEST_HOME_SHORTCODE,
      name: "Home",
    });
  });

  it("create_inventory_entry rejects swapped product/location shortcodes before inserting a row", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const product = await callSingular(
      "create_products",
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

    const location = await callSingular(
      "create_locations",
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
    const rejected = await callSingular(
      "create_inventory_entries",
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
    const product = await callSingular(
      "create_products",
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

  it("merge_entity rejects a PRODUCT shortcode as an ingredient keeper before merging anything", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const ingredient = await callSingular(
      "create_ingredients",
      { name: "Merge Victim Ingredient", aliases: [] },
      caller,
    );
    expectOk(ingredient);
    const ingredientCode = structured(ingredient).id as string;

    const product = await callSingular(
      "create_products",
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

    // Not `isError` — a wrong-prefix code fails its own CLUSTER, which is the
    // point of the batch shape: the envelope stays valid and the failure is
    // reported per cluster with a typed reason.
    const rejected = await callTool(
      "merge_entity",
      {
        entity: "ingredient",
        merges: [{ keepId: productCode, mergeIds: [ingredientCode] }],
      },
      caller,
    );
    expectOk(rejected);
    const [clusterResult] = (
      structured(rejected) as {
        results: Array<{ status: string; code?: string; error?: string }>;
      }
    ).results;
    expect(clusterResult?.status).toBe("failed");
    expect(clusterResult?.code).toBe("BAD_REQUEST");
    expect(clusterResult?.error).toContain(productCode);

    // The would-be alias survives untouched.
    const stillThere = await callTool(
      "get_ingredient",
      { id: ingredientCode },
      caller,
    );
    expectOk(stillThere);
    expect(structured(stillThere).name).toBe("Merge Victim Ingredient");
  });

  it("merge_entity rejects a PRODUCT shortcode as a vendor keeper before merging anything", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const vendor = await callSingular(
      "create_vendors",
      { name: "Merge Victim Vendor" },
      caller,
    );
    expectOk(vendor);
    const vendorCode = structured(vendor).id as string;

    const product = await callSingular(
      "create_products",
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
      "merge_entity",
      {
        entity: "vendor",
        merges: [{ keepId: productCode, mergeIds: [vendorCode] }],
      },
      caller,
    );
    expectOk(rejected);
    expect(
      (structured(rejected) as { results: Array<{ status: string }> })
        .results[0]?.status,
    ).toBe("failed");

    // The would-be loser survives untouched.
    const stillThere = await callTool("get_vendor", { id: vendorCode }, caller);
    expectOk(stillThere);
    expect(structured(stillThere).name).toBe("Merge Victim Vendor");
  });
});

// 3. Specialized tools round-trip on shortcodes

describe("specialized tools round-trip on shortcodes", () => {
  const ctx = withTestDb();

  it("merge_entity folds an ingredient into a keeper, addressed entirely by shortcode", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const target = await callSingular(
      "create_ingredients",
      { name: "Cilantro", aliases: [] },
      caller,
    );
    expectOk(target);
    const targetCode = structured(target).id as string;

    const alias = await callSingular(
      "create_ingredients",
      { name: "Coriander Leaf", aliases: [] },
      caller,
    );
    expectOk(alias);
    const aliasCode = structured(alias).id as string;

    const merged = await callTool(
      "merge_entity",
      {
        entity: "ingredient",
        merges: [{ keepId: targetCode, mergeIds: [aliasCode] }],
      },
      caller,
    );
    expectOk(merged);
    const result = (
      structured(merged) as {
        entity: string;
        results: Array<{ keepId: string; status: string; merged?: number }>;
      }
    ).results[0];
    expect(result?.status).toBe("succeeded");
    // The keeper is named, not returned — `get_ingredient` fetches it. And the
    // count is what the DELETE removed, not what the caller asked for.
    expect(result?.keepId).toBe(targetCode);
    expect(result?.merged).toBe(1);

    const aliasAfter = await callTool(
      "get_ingredient",
      { id: aliasCode },
      caller,
    );
    expect(aliasAfter.isError).toBe(true);
  });

  it("merge_entity runs each cluster independently: a self-merge is refused while its neighbour still merges", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const make = async (name: string) => {
      const created = await callSingular(
        "create_ingredients",
        { name, aliases: [] },
        caller,
      );
      expectOk(created);
      return structured(created).id as string;
    };
    const selfKeeper = await make("Batch Self Keeper");
    const goodKeeper = await make("Batch Good Keeper");
    const goodLoser = await make("Batch Good Loser");

    const result = await callTool(
      "merge_entity",
      {
        entity: "ingredient",
        merges: [
          // Names its own keeper among the ids to merge away.
          { keepId: selfKeeper, mergeIds: [selfKeeper] },
          { keepId: goodKeeper, mergeIds: [goodLoser] },
        ],
      },
      caller,
    );
    // The batch envelope is NOT an error even with a failed cluster — the
    // per-cluster outcomes are the payload.
    expectOk(result);
    const { entity, results } = structured(result) as {
      entity: string;
      results: Array<{
        keepId: string;
        status: string;
        merged?: number;
        reason?: string;
      }>;
    };
    expect(entity).toBe("ingredient");
    expect(results[0]).toMatchObject({
      keepId: selfKeeper,
      status: "failed",
      reason: "MERGE_SELF_REFERENCE",
    });
    expect(results[1]).toMatchObject({
      keepId: goodKeeper,
      status: "succeeded",
      merged: 1,
    });

    // The refused cluster wrote nothing; the successful one did.
    const keeperAfter = await callTool(
      "get_ingredient",
      { id: selfKeeper },
      caller,
    );
    expectOk(keeperAfter);
    expect(structured(keeperAfter).name).toBe("Batch Self Keeper");
    const loserAfter = await callTool(
      "get_ingredient",
      { id: goodLoser },
      caller,
    );
    expect(loserAfter.isError).toBe(true);
  });

  it("move_inventory_entries crosses source locations in one call by shortcode", async () => {
    // Boundary contract only — that the tool round-trips shortcodes and that a
    // single call spans more than one source, which `bulk_move_inventory` could
    // not express. The four per-item branches, the merge arithmetic, and the
    // ordering hazards are covered against the repo function in
    // inventory-move-entries.integration.test.ts.
    const caller = createTestCaller(domainRouter, ctx.db);

    const create = async (tool: string, args: Record<string, unknown>) => {
      const created = await callSingular(tool, args, caller);
      expectOk(created);
      return structured(created).id as string;
    };

    const widget = await create("create_products", {
      name: "Many Move Widget",
      upc: null,
      manufacturer: "Test Mfg",
      ingredientId: null,
    });
    const shelfA = await create("create_locations", {
      name: "Many Move Shelf A",
      type: "shelf",
      parentId: null,
    });
    const shelfB = await create("create_locations", {
      name: "Many Move Shelf B",
      type: "shelf",
      parentId: null,
    });
    const drawer = await create("create_locations", {
      name: "Many Move Drawer",
      type: "shelf",
      parentId: null,
    });

    const fromA = await create("create_inventory_entries", {
      productId: widget,
      locationId: shelfA,
      value: 4,
      unit: "each",
    });
    const fromB = await create("create_inventory_entries", {
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
    const recipe = await callSingular(
      "create_recipes",
      { name: "Add To Meal Recipe", meta: { url: null }, sections: [] },
      caller,
    );
    expectOk(recipe);
    const recipeCode = structured(recipe).id as string;

    const meal = await callSingular(
      "create_meals",
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
    const location = await callSingular(
      "create_locations",
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
    const caller = createTestCaller(domainRouter, ctx.db);
    const product = await callSingular(
      "create_products",
      {
        name: "Similarity Seed Product",
        upc: null,
        manufacturer: "Test Mfg",
        ingredientId: null,
      },
      caller,
    );
    expectOk(product);
    const productCode = structured(product).id as string;

    const result = await callTool(
      "find_similar_entities",
      { pair: "product_to_product", sourceId: productCode },
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
    const vendor = await callSingular(
      "create_vendors",
      { name: "Split Expense Vendor" },
      caller,
    );
    expectOk(vendor);
    const vendorCode = structured(vendor).id as string;

    const purchase = await callSingular(
      "create_purchases",
      { vendorId: vendorCode, date: "2024-01-15" },
      caller,
    );
    expectOk(purchase);

    const expense = await callSingular(
      "create_expenses",
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

  it("merge_entity merges purchases by shortcode (the intended contract)", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const vendor = await callSingular(
      "create_vendors",
      { name: "Merge Purchases Vendor" },
      caller,
    );
    expectOk(vendor);
    const vendorCode = structured(vendor).id as string;

    const keep = await callSingular(
      "create_purchases",
      { vendorId: vendorCode, date: "2024-01-15" },
      caller,
    );
    expectOk(keep);
    const keepCode = structured(keep).id as string;

    const loser = await callSingular(
      "create_purchases",
      { vendorId: vendorCode, date: "2024-01-15" },
      caller,
    );
    expectOk(loser);
    const loserCode = structured(loser).id as string;

    const merged = await callTool(
      "merge_entity",
      {
        entity: "purchase",
        merges: [{ keepId: keepCode, mergeIds: [loserCode] }],
      },
      caller,
    );
    expectOk(merged);
    const result = (
      structured(merged) as {
        results: Array<{ keepId: string; status: string; merged?: number }>;
      }
    ).results[0];
    expect(result?.status).toBe("succeeded");
    expect(result?.keepId).toBe(keepCode);
    // MEASURED, like the other three. Purchase reads its count from its own
    // bulk soft-delete's `.returning()` rather than from `finalizeMerge`,
    // which runs later inside `foldChargeInto` as a no-op — see the note on
    // `mergeEntityResultOut.merged`. One loser in, one row actually removed.
    expect(result?.merged).toBe(1);
  });

  it("merge_entity merges vendors by shortcode and tombstones the loser's own code", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const keep = await callSingular(
      "create_vendors",
      { name: "Merge Vendors Keeper" },
      caller,
    );
    expectOk(keep);
    const keepCode = structured(keep).id as string;

    const loser = await callSingular(
      "create_vendors",
      { name: "Merge Vendors Loser" },
      caller,
    );
    expectOk(loser);
    const loserCode = structured(loser).id as string;

    const merged = await callTool(
      "merge_entity",
      {
        entity: "vendor",
        merges: [{ keepId: keepCode, mergeIds: [loserCode] }],
      },
      caller,
    );
    expectOk(merged);
    const result = (
      structured(merged) as {
        results: Array<{
          keepId: string;
          status: string;
          merged?: number;
          summary: { deletedIds?: string[] };
        }>;
      }
    ).results[0];
    expect(result?.status).toBe("succeeded");
    expect(result?.keepId).toBe(keepCode);
    expect(result?.merged).toBe(1);
    expect(result?.summary.deletedIds).toEqual([loserCode]);

    // The loser's code is a permanent tombstone — it resolves to nothing, not
    // to the keeper.
    const loserAfter = await callTool("get_vendor", { id: loserCode }, caller);
    expect(loserAfter.isError).toBe(true);
  });

  it("link_expenses_to_purchase takes purchaseId/expenseIds by shortcode (the intended contract)", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
    const vendor = await callSingular(
      "create_vendors",
      { name: "Link Expenses Vendor" },
      caller,
    );
    expectOk(vendor);
    const vendorCode = structured(vendor).id as string;

    const purchase = await callSingular(
      "create_purchases",
      { vendorId: vendorCode, date: "2024-01-15" },
      caller,
    );
    expectOk(purchase);
    const purchaseCode = structured(purchase).id as string;

    const expense = await callSingular(
      "create_expenses",
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
    const project = await callSingular(
      "create_projects",
      { name: "Bulk Move Tasks Project" },
      caller,
    );
    expectOk(project);
    const projectCode = structured(project).id as string;

    const task = await callSingular(
      "create_tasks",
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

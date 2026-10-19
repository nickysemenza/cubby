import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb, unwrapDb } from "~/server/db/helpers";
import { ingredient } from "~/server/db/schema";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import { createLedgerParty } from "~/server/domains/ledger-party/repo/ledger-party";
import {
  entityKernelContextSchema,
  executeEntityAs,
} from "~/server/entity-kernel";
import { executeEntityMutationRead } from "~/server/entity-kernel/execute";
import { createEntityCrud } from "~/server/entity-kernel/repo/repository";
import { createMcpServer } from "~/server/mcp/server";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  callMcpTool,
  kernelRequestContext,
} from "~/server/testing/mcp-test-utils";
import {
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

// An output read must not become a prerequisite for the mutation or its audit.
describe("summary mutation output demand", () => {
  const ctx = withTestDb("mcp");
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());
  it("uses a final-read callback instead of invoking unrequested non-Product detail hydration", async () => {
    const seeded = await findOrCreateIngredient(
      ctx.db,
      "Synthetic output-demand ingredient",
    );
    const crud = createEntityCrud({
      entity: "ingredient",
      table: ingredient,
      fetchById: (db, id) =>
        unwrapDb(db).query.ingredient.findFirst({
          where: eq(ingredient.id, id),
        }),
      fromDB: () => {
        throw new Error("Unrequested non-Product detail hydration");
      },
      toUpdate: (data: { name: string }) => ({ name: data.name }),
      auditUpdateFields: ["name"],
    });
    const result = await crud.update(
      ctx.db,
      seeded.id,
      { name: "Synthetic renamed ingredient" },
      ctx.actor,
      async (_db, receipt) => ({ id: receipt.shortcode }),
    );
    expect(result).toEqual({ id: seeded.shortcode });
    expect(
      await getDb(ctx.db).query.ingredient.findFirst({
        where: eq(ingredient.id, seeded.id),
        columns: { name: true },
      }),
    ).toEqual({ name: "Synthetic renamed ingredient" });
  });
  it("creates and updates Recipe Ingredient and Location through reference-only MCP commands", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const call = (commands: unknown[]) =>
      callMcpTool(
        createMcpServer(),
        "entity",
        { action: "commands", resultDetail: "summary", commands },
        kernelRequestContext(context),
        { entityKernel: context },
      );
    const created = await call([
      {
        action: "create",
        entity: "recipe",
        data: makeRecipeInput({ name: "Synthetic summary recipe" }),
      },
      {
        action: "create",
        entity: "ingredient",
        data: { name: "Synthetic summary ingredient" },
      },
      {
        action: "create",
        entity: "location",
        data: { name: "Synthetic summary location", type: "room" },
      },
    ]);
    const batch = z.object({
      summary: z.object({ succeeded: z.number(), failed: z.number() }),
      results: z.array(z.object({ reference: z.string() })),
    });
    const result = batch.parse(created.structuredContent);
    expect(result.summary).toEqual({ succeeded: 3, failed: 0 });
    const entities = ["recipe", "ingredient", "location"];
    const changes = result.results.map((row, index) => ({
      action: "update",
      entity: entities[index],
      id: row.reference,
      data: { name: `Synthetic renamed summary ${entities[index]}` },
    }));
    const updated = await call(changes);
    expect(batch.parse(updated.structuredContent).summary).toEqual({
      succeeded: 3,
      failed: 0,
    });
    for (const [index, row] of result.results.entries()) {
      const read = await callMcpTool(
        createMcpServer(),
        "entity_read",
        {
          action: "get",
          entity: entities[index],
          id: row.reference,
          resultDetail: "full",
        },
        kernelRequestContext(context),
        { entityKernel: context },
      );
      expect(read.structuredContent).toMatchObject({
        item: { name: `Synthetic renamed summary ${entities[index]}` },
      });
    }
  });
  it("keeps owner Sources current on the survivor of a summary Inventory ownership merge", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const owner = await createLedgerParty(
      ctx.db,
      { name: "Synthetic summary owner", kind: "member", notes: null },
      ctx.actor,
    );
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic summary ownership product" }),
      ctx.actor,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic summary ownership shelf" }),
      ctx.actor,
    );
    const original = await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: location.entityId,
        amount: { value: 1, unit: "each" },
        ownershipMode: "inherit",
      },
      ctx.actor,
    );
    const survivor = await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: location.entityId,
        amount: { value: 2, unit: "each" },
        ownershipMode: "explicit",
        ownerLedgerPartyId: owner.entityId,
      },
      ctx.actor,
    );

    const result = await executeEntityMutationRead(
      context,
      {
        action: "update",
        entity: "inventory",
        id: parseShortcodeFor("inventory", original.id),
        data: {
          ownershipMode: "explicit",
          ownerLedgerPartyId: owner.output.id,
        },
        sources: [
          {
            fieldPath: "ownerLedgerPartyId",
            quote: "Synthetic ownership label",
          },
        ],
      },
      ["id"],
    );
    expect(result.item).toMatchObject({ id: survivor.id });
    const read = await executeEntityAs(context, "get", {
      entity: "inventory",
      id: survivor.id,
      missing: "error",
    });
    expect(read.item).toMatchObject({
      sources: [
        expect.objectContaining({
          fieldPath: "ownerLedgerPartyId",
          quote: "Synthetic ownership label",
          supportsCurrentValue: true,
        }),
      ],
    });
  });
});

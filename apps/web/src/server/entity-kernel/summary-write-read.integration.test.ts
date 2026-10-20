import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
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
  // Non-column scalars must retain normalized receipts and citation equality;
  // inherited Source values can differ from the saved override in the receipt.
  it("keeps linked Project URL citations current through unrelated saves and clearing", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const subject = await createRepoEntity(ctx, "project");
    const url = "https://drive.google.com/drive/folders/synthetic-folder";
    const result = await executeEntityMutationRead(
      context,
      {
        action: "update",
        entity: "project",
        id: subject.output.id,
        data: { googleDriveFolderUrl: url },
        sources: [
          {
            fieldPath: "googleDriveFolderUrl",
            quote: "Synthetic folder label",
          },
        ],
      },
      ["id", "googleDriveFolderUrl"],
    );
    expect(result.item).toMatchObject({ googleDriveFolderUrl: url });
    const read = async () =>
      (
        await executeEntityAs(context, "get", {
          entity: "project",
          id: subject.output.id,
          missing: "error",
        })
      ).item;
    expect(await read()).toMatchObject({
      sources: [expect.objectContaining({ supportsCurrentValue: true })],
    });
    await executeEntityMutationRead(
      context,
      {
        action: "update",
        entity: "project",
        id: subject.output.id,
        data: { notes: "Synthetic unrelated edit" },
        sources: [
          {
            fieldPath: "googleDriveFolderUrl",
            quote: "Synthetic second observation",
          },
        ],
      },
      ["id"],
    );
    expect(await read()).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          quote: "Synthetic second observation",
          supportsCurrentValue: true,
        }),
      ]),
    });
    await executeEntityMutationRead(
      context,
      {
        action: "update",
        entity: "project",
        id: subject.output.id,
        data: { googleDriveFolderUrl: null },
      },
      ["id"],
    );
    expect(await read()).toMatchObject({
      googleDriveFolderUrl: null,
      sources: expect.arrayContaining([
        expect.objectContaining({
          quote: "Synthetic folder label",
          supportsCurrentValue: false,
        }),
      ]),
    });
  });

  it("fingerprints inherited Project values while returning the saved override", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const parent = await createRepoEntity(ctx, "project", {
      defaultTrade: "plumbing",
    });
    const child = await createRepoEntity(ctx, "project", {
      parentProjectId: parent.output.id,
      defaultTrade: "electrical",
    });
    const result = await executeEntityMutationRead(
      context,
      {
        action: "update",
        entity: "project",
        id: child.output.id,
        data: { defaultTrade: null },
        sources: [
          { fieldPath: "defaultTrade", quote: "Synthetic inherited trade" },
        ],
      },
      ["id", "defaultTrade"],
    );
    expect(result.item).toMatchObject({ defaultTrade: null });
    const read = async () =>
      (
        await executeEntityAs(context, "get", {
          entity: "project",
          id: child.output.id,
          missing: "error",
        })
      ).item;
    expect(await read()).toMatchObject({
      defaultTrade: "plumbing",
      sources: [expect.objectContaining({ supportsCurrentValue: true })],
    });
    await executeEntityMutationRead(
      context,
      {
        action: "update",
        entity: "project",
        id: parent.output.id,
        data: { defaultTrade: "electrical" },
      },
      ["id"],
    );
    expect(await read()).toMatchObject({
      sources: [expect.objectContaining({ supportsCurrentValue: false })],
    });
  });

  it("returns and fingerprints card scalar projections instead of the identity object", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const account = await createRepoEntity(ctx, "financialAccount", {
      identity: { kind: "credit_card", issuer: null, network: null },
    });
    const result = await executeEntityMutationRead(
      context,
      {
        action: "update",
        entity: "financialAccount",
        id: account.output.id,
        data: { issuer: "Synthetic Bank", network: "visa" },
        sources: [
          { fieldPath: "issuer", quote: "Synthetic issuer label" },
          { fieldPath: "network", quote: "Synthetic network label" },
        ],
      },
      ["id", "issuer", "network"],
    );
    expect(result.item).toMatchObject({
      issuer: "Synthetic Bank",
      network: "visa",
    });
    const read = await executeEntityAs(context, "get", {
      entity: "financialAccount",
      id: account.output.id,
      missing: "error",
    });
    expect(read.item).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "issuer",
          supportsCurrentValue: true,
        }),
        expect.objectContaining({
          fieldPath: "network",
          supportsCurrentValue: true,
        }),
      ]),
    });
  });
  it("keeps Expense purchase scalar citations equal to the normalized detail values", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const subject = await createRepoEntity(ctx, "expense", {
      vendor: "Synthetic initial merchant",
      orderId: "synthetic-order-one",
      trade: "other",
    });
    const result = await executeEntityMutationRead(
      context,
      {
        action: "update",
        entity: "expense",
        id: subject.output.id,
        data: {
          vendor: "Synthetic current merchant",
          orderId: "synthetic-order-two",
        },
        sources: [
          { fieldPath: "vendor", quote: "Synthetic merchant heading" },
          { fieldPath: "orderId", quote: "Synthetic order heading" },
        ],
      },
      ["id", "vendor", "orderId"],
    );
    expect(result.item).toMatchObject({
      vendor: "Synthetic current merchant",
      orderId: "synthetic-order-two",
    });
    const read = async () =>
      (
        await executeEntityAs(context, "get", {
          entity: "expense",
          id: subject.output.id,
          missing: "error",
        })
      ).item;
    expect(await read()).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "vendor",
          supportsCurrentValue: true,
        }),
        expect.objectContaining({
          fieldPath: "orderId",
          supportsCurrentValue: true,
        }),
      ]),
    });
    await executeEntityMutationRead(
      context,
      {
        action: "update",
        entity: "expense",
        id: subject.output.id,
        data: { orderId: null },
      },
      ["id"],
    );
    expect(await read()).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "orderId",
          supportsCurrentValue: false,
        }),
      ]),
    });
  });

  it("normalizes Inventory amount columns in receipts and scalar citations", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic amount product" }),
      ctx.actor,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic amount shelf" }),
      ctx.actor,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: location.entityId,
        amount: { value: 1, unit: "each" },
        ownershipMode: "inherit",
      },
      ctx.actor,
    );
    const result = await executeEntityMutationRead(
      context,
      {
        action: "update",
        entity: "inventory",
        id: parseShortcodeFor("inventory", entry.id),
        data: { amount: { value: 2, unit: "each" } },
        sources: [{ fieldPath: "amount", quote: "Synthetic counted amount" }],
      },
      ["id", "amount"],
    );
    expect(result.item).toMatchObject({ amount: { value: 2, unit: "each" } });
    const read = async () =>
      (
        await executeEntityAs(context, "get", {
          entity: "inventory",
          id: entry.id,
          missing: "error",
        })
      ).item;
    expect(await read()).toMatchObject({
      sources: [expect.objectContaining({ supportsCurrentValue: true })],
    });
    await executeEntityMutationRead(
      context,
      {
        action: "update",
        entity: "inventory",
        id: parseShortcodeFor("inventory", entry.id),
        data: { amount: { value: 3, unit: "each" } },
      },
      ["id"],
    );
    expect(await read()).toMatchObject({
      sources: [expect.objectContaining({ supportsCurrentValue: false })],
    });
  });

  it("projects a single FinancialTransaction allocation as a Purchase identity", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const vendor = await createRepoEntity(ctx, "vendor");
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-04-01",
      orderId: "synthetic-source-allocation",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      identity: { kind: "cash" },
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-04-01",
      amount: 4,
      allocations: [{ purchaseId: purchase.output.id, amount: 4 }],
    });
    const result = await executeEntityMutationRead(
      context,
      {
        action: "update",
        entity: "financialTransaction",
        id: transaction.output.id,
        data: { notes: "Synthetic allocation observation" },
        sources: [
          { fieldPath: "purchaseId", quote: "Synthetic single allocation" },
        ],
      },
      ["id"],
    );
    expect(result.item).toEqual({ id: transaction.output.id });
    const read = await executeEntityAs(context, "get", {
      entity: "financialTransaction",
      id: transaction.output.id,
      missing: "error",
    });
    expect(read.item).toMatchObject({
      purchaseId: purchase.output.id,
      sources: [expect.objectContaining({ supportsCurrentValue: true })],
    });
  });

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

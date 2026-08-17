import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import type { ProjectShortcode } from "@cubby/schemas/identifiers";
import { ingredientCreateInput } from "@cubby/schemas/ingredient";
import { expenseCreateInput, projectCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { wishCreateInput } from "@cubby/schemas/wish";
import { parseShortcode } from "@cubby/shared";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, expectTypeOf, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { createTestCaller } from "~/server/api/trpc";
import {
  getBackgroundBatchDetail,
  listBackgroundBatches,
} from "~/server/repo/background-jobs";
import { createExpense } from "~/server/repo/expense";
import { createFinancialAccount } from "~/server/repo/financial-account";
import { createFinancialTransaction } from "~/server/repo/financial-transaction";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { ingredientRouter } from "./ingredient";
import { locationRouter } from "./location";
import { productRouter } from "./product";
import { projectRouter } from "./project";
import { purchaseRouter } from "./purchase";
import { vendorRouter } from "./vendor";
import { wishRouter } from "./wish";

describe("searchable CRUD factory", () => {
  const ctx = withTestDb();

  it("preserves branded IDs and runs create/update embedding side effects", async () => {
    const caller = createTestCaller(projectRouter, ctx.db);
    const created = await caller.create(
      mock(projectCreateInput, {
        overrides: { name: "Searchable CRUD project" },
      }),
    );
    expectTypeOf(created.id).toEqualTypeOf<ProjectShortcode>();

    const updated = await caller.update({
      id: created.id,
      data: { name: "Updated searchable CRUD project" },
    });
    expect(updated.id).toBe(created.id);

    const batches = await listBackgroundBatches(ctx.db, 20);
    expect(
      batches.filter((batch) => batch.kind === "entity-embedding.refresh"),
    ).toHaveLength(2);
  });
});

/**
 * The shortcode cutover's ground truth: every entity that crosses the MCP
 * boundary must mint a real, well-formed, correctly-prefixed shortcode on
 * create — independent of whatever the MCP output-projection layer
 * (`apps/web/src/server/mcp/tools/**`, mid-flight as of this writing) does
 * with that value. This exercises the router layer directly (uuid ids, same
 * as every other router test in this file) so a regression here can only be
 * "the repo stopped minting a shortcode," never "the MCP slim projection
 * hasn't been updated yet."
 */
describe("every entity router stamps a usable, correctly-prefixed shortcode on create", () => {
  const ctx = withTestDb();

  // One row per entity: a `create` thunk (the routers' input shapes differ too
  // much to share one) and the shortcode type its id must carry. A new
  // MCP-crossing entity gets a row rather than a copied block.
  //
  // `vendor.id` IS the shortcode — vendor has no separate `.shortcode` field
  // (collapsed in the shortcode cutover, unlike product/location/ingredient,
  // which haven't gone through it yet). The assertion is the same either way,
  // which is what makes one table legitimate here.
  const CREATES: ReadonlyArray<
    [string, (db: typeof ctx.db) => Promise<{ id: string }>]
  > = [
    [
      "product",
      (db) =>
        createTestCaller(productRouter, db).create(
          makeProductInput({ name: "Shortcode Ground Truth Product" }),
        ),
    ],
    [
      "location",
      (db) =>
        createTestCaller(locationRouter, db).create(
          makeLocationInput({ name: "Shortcode Ground Truth Location" }),
        ),
    ],
    [
      "ingredient",
      (db) =>
        createTestCaller(ingredientRouter, db).create(
          mock(ingredientCreateInput, {
            overrides: { name: "Shortcode Ground Truth Ingredient" },
          }),
        ),
    ],
    [
      "vendor",
      (db) =>
        createTestCaller(vendorRouter, db).create(
          mock(vendorCreateInput, {
            overrides: { name: "Shortcode Ground Truth Vendor" },
          }),
        ),
    ],
  ];

  it.each(CREATES)("%s", async (entity, create) => {
    const created = await create(ctx.db);
    expect(parseShortcode(created.id)).toMatchObject({
      type: entity,
      legacy: false,
    });
  });
});

/**
 * vendor / wish / purchase used to hand-roll `getByID` + `create` + `update` +
 * `delete`, with two divergences from the factory that leaked into call sites:
 * `getByID` took a BARE scalar id, and `delete` resolved to `void`. Both are
 * gone now that all three sit on `createSearchableEntityCrudProcedures`, so
 * these pin the factory's contract at the router boundary.
 */
describe("factory-migrated routers expose the standard getByID/delete contract", () => {
  const ctx = withTestDb();

  const expectSideEffectSummary = (result: unknown) =>
    expect(result).toMatchObject({
      sideEffects: { backgroundBatches: expect.any(Array) },
    });

  /**
   * What a row hands the shared body. The three calls are pre-bound closures
   * rather than a shared caller type: each router's ids are branded to its own
   * entity, so nothing narrower than "call it for me" is assignable across all
   * three.
   */
  interface FactoryCrudSubject {
    id: string;
    /** Fields `getByID` must read back beyond the id. */
    expected: Record<string, unknown>;
    getByID: () => Promise<unknown>;
    getByShortcode: () => Promise<unknown>;
    remove: () => Promise<unknown>;
  }

  // Each row only creates its entity and names what `getByID` should read back.
  // Everything after that — the `getByShortcode` adapter, the side-effect
  // summary on delete, and the post-delete throw — is the factory contract
  // itself, identical per entity, so it is asserted once below instead of
  // copied per block. A newly factory-migrated router gets a row.
  //
  // `getByShortcode` is what every detail-page route loader calls, so a broken
  // adapter there 500s the page while `getByID` stays green.
  const SUBJECTS: ReadonlyArray<
    [string, (db: typeof ctx.db) => Promise<FactoryCrudSubject>]
  > = [
    [
      "vendor",
      async (db) => {
        const caller = createTestCaller(vendorRouter, db);
        const { id } = await caller.create(
          mock(vendorCreateInput, { overrides: { name: "Contract Vendor" } }),
        );
        return {
          id,
          expected: { name: "Contract Vendor" },
          getByID: () => caller.getByID({ id }),
          getByShortcode: () => caller.getByShortcode({ shortcode: id }),
          remove: () => caller.delete({ ids: [id] }),
        };
      },
    ],
    [
      "wish",
      async (db) => {
        const caller = createTestCaller(wishRouter, db);
        const { id } = await caller.create(
          mock(wishCreateInput, {
            overrides: { name: "Contract Wish", candidateProductIds: [] },
          }),
        );
        return {
          id,
          expected: { name: "Contract Wish" },
          getByID: () => caller.getByID({ id }),
          getByShortcode: () => caller.getByShortcode({ shortcode: id }),
          remove: () => caller.delete({ ids: [id] }),
        };
      },
    ],
    [
      "purchase",
      async (db) => {
        const vendor = await createTestCaller(vendorRouter, db).create(
          mock(vendorCreateInput, {
            overrides: { name: "Contract Purchase Co" },
          }),
        );
        const caller = createTestCaller(purchaseRouter, db);
        const { id } = await caller.create(
          mock(purchaseCreateInput, {
            overrides: {
              vendorId: vendor.id,
              orderId: "CONTRACT-1",
              pendingImageIds: [],
            },
          }),
        );
        return {
          id,
          expected: { vendorId: vendor.id },
          getByID: () => caller.getByID({ id }),
          getByShortcode: () => caller.getByShortcode({ shortcode: id }),
          remove: () => caller.delete({ ids: [id] }),
        };
      },
    ],
  ];

  it.each(SUBJECTS)("%s", async (_entity, seed) => {
    const subject = await seed(ctx.db);

    expect(await subject.getByID()).toMatchObject({
      id: subject.id,
      ...subject.expected,
    });
    expect(await subject.getByShortcode()).toMatchObject({ id: subject.id });

    expectSideEffectSummary(await subject.remove());
    await expect(subject.getByID()).rejects.toThrow();
  });

  /**
   * The one piece of `purchase.delete` the factory has no hook for: deleting a
   * Purchase DETACHES its Expenses and FinancialTransactions, and those rows
   * embed the purchase's identity, so each has to be reindexed. The router's
   * `repository.delete` adapter dispatches that wave itself; an adapter that
   * dropped it would still typecheck and still pass every test above.
   */
  it("purchase delete reindexes the expenses and transactions it detaches", async () => {
    const vendor = await createTestCaller(vendorRouter, ctx.db).create(
      mock(vendorCreateInput, { overrides: { name: "Detach Supply" } }),
    );
    const caller = createTestCaller(purchaseRouter, ctx.db);
    const purchase = await caller.create(
      mock(purchaseCreateInput, {
        overrides: {
          vendorId: vendor.id,
          orderId: "DETACH-1",
          pendingImageIds: [],
        },
      }),
    );

    const { entityId: expenseId } = await createExpense(
      ctx.db,
      mock(expenseCreateInput, {
        overrides: {
          name: "Detached line",
          purchaseId: purchase.id,
          cost: 25,
          date: "2026-07-01",
        },
      }),
      ctx.actor,
    );
    const { output: account } = await createFinancialAccount(
      ctx.db,
      mock(financialAccountCreateInput, {
        overrides: { name: "Detach Card", provisional: false },
      }),
      ctx.actor,
    );
    const { entityId: transactionId } = await createFinancialTransaction(
      ctx.db,
      mock(financialTransactionCreateInput, {
        overrides: {
          accountId: account.id,
          purchaseId: purchase.id,
          kind: "purchase",
          status: "posted",
          amount: 25,
          transactionDate: "2026-07-01",
          postedDate: "2026-07-02",
        },
      }),
      ctx.actor,
    );

    await caller.delete({ ids: [purchase.id] });

    const batches = await listBackgroundBatches(ctx.db, 50);
    const details = await Promise.all(
      batches
        .filter(
          (batch) =>
            batch.kind === "entity-embedding.refresh" &&
            (batch.metadata as { source?: string } | null)?.source ===
              "purchase.delete",
        )
        .map((batch) => getBackgroundBatchDetail(ctx.db, batch.id)),
    );
    const payloads = details.flatMap(
      (detail) => detail?.jobs.map((job) => job.payload) ?? [],
    );
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: "expense", entityId: expenseId }),
        expect.objectContaining({
          entityType: "financialTransaction",
          entityId: transactionId,
        }),
      ]),
    );
  });
});

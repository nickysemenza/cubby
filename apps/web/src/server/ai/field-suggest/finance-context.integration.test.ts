import {
  fieldSuggestionsInput,
  financeCategoryApplyInput,
} from "@cubby/schemas/ai";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { JevPort } from "~/server/ai/jev";
import {
  financialTransaction,
  financialTransactionAllocation,
  product,
  expense,
  purchase as purchaseTable,
  spendingCategory,
} from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { getDb } from "~/server/repo/database-helpers";
import { applyFinanceCategorySuggestion } from "~/server/repo/finance-suggestion-context";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";
import { createTestRequestContext } from "~/server/testing/request-context";

import { suggestFields } from "./suggest-fields";

// Failure modes: linked receipt evidence omitted; proposing writes before review;
// changed Product or line evidence still permits a reviewed category to overwrite
// the authoritative Expense; retired or sibling lines leak into its proposal.
describe("reviewed linked finance category suggestions", () => {
  const ctx = withTestDb();
  async function fixture() {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture clothing",
    });
    const explicit = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture explicit",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture mixed shop",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-01",
    });
    const good = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Fixture black crew shirt",
        manufacturer: "Fixture apparel",
      }),
      ctx.actor,
    );
    const line = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture crew shirt line",
      cost: 29.99,
      date: "2026-09-01",
      costType: "materials",
      trade: "other",
      purchaseId: purchase.id,
      productId: good.entityId,
      productQuantity: 2,
    });
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Fixture member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Fixture card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: party.id,
    });
    const charge = await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 29.99,
      postedDate: "2026-09-01",
      spendingCategoryId: explicit.id,
    });
    const [allocation] = await getDb(ctx.db)
      .insert(financialTransactionAllocation)
      .values({
        transactionId: charge.id,
        purchaseId: purchase.id,
        amount: 29.99,
      })
      .returning();
    if (!allocation) throw new Error("Missing fixture allocation");
    const jev = vi.fn<JevPort>(async (input) => {
      const entries = Object.entries(input.questions.selection.criteria);
      const choice = entries.find(([, label]) =>
        label.includes(category.shortcode),
      );
      if (!choice) throw new Error("Missing fixture category choice");
      return {
        answers: {
          selection: {
            type: "choice",
            choice: choice[0],
            confidence: 0.96,
            probabilities: Object.fromEntries(
              entries.map(([key]) => [
                key,
                key === choice[0] ? 0.96 : 0.04 / (entries.length - 1),
              ]),
            ),
          },
        },
      };
    });
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const suggest = (
      entity: "purchase" | "expense" = "expense",
      entityId: string = line.shortcode,
    ) =>
      suggestFields(
        ctx.db,
        runId,
        fieldSuggestionsInput.parse({
          entity,
          entityId,
          basisMode: "provided",
          targets: ["spendingCategoryId"],
          basis: { merchant: "Unsaved misleading restaurant" },
        }),
        { jev },
      );
    const context = entityKernelContextSchema.parse({
      ...createTestRequestContext(ctx.db),
      actorContext: ctx.actor,
    });
    return {
      vendor,
      category,
      explicit,
      purchase,
      good,
      line,
      charge,
      allocation,
      jev,
      suggest,
      context,
    };
  }
  it("uses persisted own-line evidence and refuses changed Product or cost before applying", async () => {
    const f = await fixture();
    const proposal = (await f.suggest()).suggestions.spendingCategoryId;
    expect(proposal?.value).toBe(f.category.shortcode);
    expect(proposal?.financeReview?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const subject = f.jev.mock.calls[0]![0].state;
    expect(subject).toContain("Fixture black crew shirt");
    expect(subject).toContain('"productQuantity":2');
    expect(subject).not.toContain("Unsaved misleading restaurant");
    expect(subject.split("Fixture crew shirt line")).toHaveLength(2);
    const stored = async () =>
      (
        await getDb(ctx.db)
          .select()
          .from(expense)
          .where(eq(expense.id, f.line.id))
      )[0]?.spendingCategoryId;
    expect(await stored()).toBeNull();
    if (!proposal?.financeReview || !proposal.value)
      throw new Error("Missing reviewed proposal");
    const apply = () =>
      applyFinanceCategorySuggestion(
        f.context,
        financeCategoryApplyInput.parse({
          ...proposal.financeReview!,
          spendingCategoryId: proposal.value!,
        }),
      );
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Fixture changed drill" })
      .where(eq(product.id, f.good.entityId));
    await expect(apply()).rejects.toThrow(/changed.*review again/i);
    expect(await stored()).toBeNull();
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Fixture black crew shirt" })
      .where(eq(product.id, f.good.entityId));
    await getDb(ctx.db)
      .update(expense)
      .set({ cost: 20 })
      .where(eq(expense.id, f.line.id));
    await expect(apply()).rejects.toThrow(/changed.*review again/i);
    expect(await stored()).toBeNull();
    const fresh = (await f.suggest()).suggestions.spendingCategoryId;
    if (!fresh?.financeReview || !fresh.value)
      throw new Error("Missing fresh proposal");
    await applyFinanceCategorySuggestion(
      f.context,
      financeCategoryApplyInput.parse({
        ...fresh.financeReview,
        spendingCategoryId: fresh.value,
      }),
    );
    expect(await stored()).toBe(f.category.id);
  });
  it("keeps mixed roles distinct, excludes retired evidence, and scopes an Expense to its own line", async () => {
    const f = await fixture();
    await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture shipment tax",
      cost: 2,
      date: "2026-09-01",
      costType: "materials",
      purchaseId: f.purchase.id,
      lineKind: "tax",
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture friend reimbursement",
      cost: -8,
      date: "2026-09-01",
      costType: "materials",
      purchaseId: f.purchase.id,
      economicRole: "reimbursement",
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture retired aggregate",
      cost: 29.99,
      date: "2026-09-01",
      costType: "materials",
      purchaseId: f.purchase.id,
      deletedAt: new Date(),
    });
    await f.suggest("purchase", f.purchase.shortcode);
    const mixed = f.jev.mock.calls.at(-1)![0].state;
    expect(mixed).toContain("Fixture shipment tax");
    expect(mixed).toContain('"lineKind":"tax"');
    expect(mixed).toContain('"economicRole":"reimbursement"');
    expect(mixed).toContain('"cost":-8');
    expect(mixed).not.toContain("Fixture retired aggregate");
    await f.suggest("expense", f.line.shortcode);
    const ownLine = f.jev.mock.calls.at(-1)![0].state;
    expect(ownLine).toContain("Fixture black crew shirt");
    expect(ownLine).not.toContain("Fixture shipment tax");
    expect(ownLine).not.toContain("Fixture friend reimbursement");
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, f.good.entityId));
    await f.suggest("purchase", f.purchase.shortcode);
    expect(f.jev.mock.calls.at(-1)![0].state).not.toContain(
      "Fixture black crew shirt",
    );
  });

  it("revokes reviews for scalar, roster meaning, quantity and inherited-versus-explicit category drift", async () => {
    const f = await fixture();
    const apply = async (
      entity: "expense",
      entityId: string,
      change: () => Promise<void>,
    ) => {
      const proposed = (await f.suggest(entity, entityId)).suggestions
        .spendingCategoryId;
      if (!proposed?.financeReview)
        throw new Error("Missing reviewed proposal");
      await change();
      await expect(
        applyFinanceCategorySuggestion(
          f.context,
          financeCategoryApplyInput.parse({
            ...proposed.financeReview,
            spendingCategoryId: proposed.value,
          }),
        ),
      ).rejects.toThrow(/changed.*review again/i);
    };
    await apply("expense", f.line.shortcode, async () => {
      await getDb(ctx.db)
        .update(expense)
        .set({ name: "Fixture different line" })
        .where(eq(expense.id, f.line.id));
    });
    await apply("expense", f.line.shortcode, async () => {
      await getDb(ctx.db)
        .update(spendingCategory)
        .set({ name: "Fixture changed category meaning" })
        .where(eq(spendingCategory.id, f.category.id));
    });
    await apply("expense", f.line.shortcode, async () => {
      await getDb(ctx.db)
        .update(expense)
        .set({ productQuantity: 3 })
        .where(eq(expense.id, f.line.id));
    });
    await getDb(ctx.db)
      .update(purchaseTable)
      .set({ spendingCategoryId: f.explicit.id })
      .where(eq(purchaseTable.id, f.purchase.id));
    await apply("expense", f.line.shortcode, async () => {
      await getDb(ctx.db)
        .update(expense)
        .set({ spendingCategoryId: f.explicit.id })
        .where(eq(expense.id, f.line.id));
    });
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(financialTransaction)
          .where(eq(financialTransaction.id, f.charge.id))
      )[0]?.spendingCategoryId,
    ).toBe(f.explicit.id);
    await expect(f.suggest("expense", f.charge.shortcode)).rejects.toThrow(
      /EXP|expense|shortcode|pattern/i,
    );
  });
});

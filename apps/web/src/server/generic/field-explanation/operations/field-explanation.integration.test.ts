import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { fieldResolutionSchema } from "@cubby/schemas/field-resolution";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { itemizationExpectation } from "@cubby/schemas/purchase-evidence-policy";
import type { VendorSpendingProfile } from "@cubby/schemas/spending-classification";
import { moneyToMinor } from "@cubby/shared";
import { sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyId } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, unwrapDb } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { financialTransactionAllocation } from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import { expenseSpendingCategoryResolutionSql } from "~/server/domains/expense/repo/expense-category-resolution";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { explainField } from "~/server/generic/field-explanation/operations/field-explanation.server";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("derived field explanations against canonical records", () => {
  const ctx = withTestDb();

  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  async function explainExpenseCategory(line: {
    id: string;
    shortcode: string;
  }) {
    const result = await unwrapDb(ctx.db).execute(
      sql`
      SELECT ${expenseSpendingCategoryResolutionSql("e")} AS resolution
      FROM "Expense" e WHERE e.id=${line.id} AND e."deletedAt" IS NULL`,
      "objects",
    );
    const canonical = fieldResolutionSchema.parse(result[0]?.resolution);
    const explanation = await explainField(context(), {
      entityKind: "expense",
      entityId: parseShortcodeFor("expense", line.shortcode),
      field: "spendingCategoryId",
      surface: "list",
    });
    expect(fieldValueOf(explanation.envelope)).toEqual(canonical.value);
    expect(explanation).not.toHaveProperty("resolution");
    expect(explanation).not.toHaveProperty("derived");
    return explanation;
  }

  async function categoryContextFixture(profile: VendorSpendingProfile) {
    const mapped = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic grocery mapping",
    });
    const contextual = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic dining context",
    });
    const deliberate = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic deliberate purpose",
    });
    const category = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic prepared food",
      parentId: taxonomyId("food"),
      spendingCategoryMode: "mapped",
      spendingCategoryId: mapped.id,
    });
    const productRecord = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic food item",
        categoryId: parseShortcodeFor("productCategory", category.shortcode),
      }),
      ctx.actor,
    );
    const product = { id: productRecord.entityId, shortcode: productRecord.id };
    const vendorRecord = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic category context vendor",
      spendingProfile: profile,
      defaultSpendingCategoryId: parseShortcodeFor(
        "spendingCategory",
        contextual.shortcode,
      ),
    });
    const vendor = {
      id: vendorRecord.entityId,
      shortcode: vendorRecord.output.id,
    };
    const purchaseRecord = await createRepoEntity(ctx, "purchase", {
      vendorId: vendorRecord.output.id,
      spendingCategoryId: parseShortcodeFor(
        "spendingCategory",
        deliberate.shortcode,
      ),
    });
    const purchase = {
      id: purchaseRecord.entityId,
      shortcode: purchaseRecord.output.id,
    };
    const lineRecord = await createRepoEntity(ctx, "expense", {
      name: "Synthetic category context line",
      trade: "other",
      lineKind: "principal",
      date: "2026-09-01",
      cost: 8,
      costType: "materials",
      productId: productRecord.id,
      purchaseId: purchaseRecord.output.id,
    });
    const line = { id: lineRecord.entityId, shortcode: lineRecord.output.id };
    return {
      mapped,
      contextual,
      deliberate,
      category,
      product,
      vendor,
      purchase,
      line,
    };
  }

  // A field's recorded Sources must stay visible after the value changes, but
  // must not read as supporting the new value.

  // Category explanation must follow the SQL owner's eligibility even for
  // assigned alternatives that lose to context, a block, or a stored reference.
  it.each([
    { profile: "restaurant", contextWins: true },
    { profile: "mixed_retail", contextWins: false },
  ] satisfies { profile: VendorSpendingProfile; contextWins: boolean }[])(
    "explains $profile food context versus retail category mapping",
    async ({ profile, contextWins }) => {
      const f = await categoryContextFixture(profile);
      const explanation = await explainExpenseCategory(f.line);
      expect(fieldValueOf(explanation.envelope)).toBe(
        contextWins ? f.contextual.shortcode : f.mapped.shortcode,
      );
      expect(explanation.resolutionEvidence?.fallbackSource?.entityId).toBe(
        contextWins ? f.vendor.shortcode : f.category.shortcode,
      );
      expect(
        explanation.resolutionEvidence?.chain.rows.find(
          (row) => row.title === "Vendor food context",
        )?.state,
      ).toEqual(
        contextWins
          ? { kind: "done", label: "Used" }
          : { kind: "skipped", label: "Not applicable to this line" },
      );
      expect(
        explanation.resolutionEvidence?.chain.rows.find(
          (row) => row.id === f.category.shortcode,
        )?.state,
      ).toEqual(
        contextWins
          ? { kind: "skipped", label: "Not applicable to this line" }
          : { kind: "done", label: "Used" },
      );
      expect(
        explanation.resolutionEvidence?.chain.rows.find(
          (row) => row.id === f.purchase.shortcode,
        )?.state,
      ).toEqual({ kind: "skipped", label: "Evaluated · overridden" });
    },
  );

  it("explains a blocked mapping without suppressing a deliberate Purchase fallback", async () => {
    const f = await categoryContextFixture("restaurant");
    const blocked = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic blocked food mapping",
      parentId: f.category.id,
      spendingCategoryMode: "blocked",
    });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Product" SET "categoryId"=${blocked.id} WHERE id=${f.product.id}`,
    );
    const explanation = await explainExpenseCategory(f.line);
    expect(fieldValueOf(explanation.envelope)).toBe(f.deliberate.shortcode);
    expect(explanation.resolutionEvidence?.fallbackSource?.entityId).toBe(
      f.purchase.shortcode,
    );
    expect(
      explanation.resolutionEvidence?.chain.rows.find(
        (row) => row.id === blocked.shortcode,
      ),
    ).toMatchObject({ trailing: "Blocked", state: { kind: "skipped" } });
    expect(
      explanation.resolutionEvidence?.chain.rows.find(
        (row) => row.id === f.category.shortcode,
      ),
    ).toMatchObject({
      trailing: "Synthetic grocery mapping",
      state: { kind: "skipped" },
    });
    expect(
      explanation.resolutionEvidence?.chain.rows
        .filter((row) => row.entity === "vendor")
        .every((row) => row.state?.label === "Not applicable to this line"),
    ).toBe(true);
    expect(
      explanation.resolutionEvidence?.chain.rows.find(
        (row) => row.id === f.purchase.shortcode,
      )?.state?.kind,
    ).toBe("done");
  });

  it("keeps a retained Product reference ineligible for merchant fallback after soft deletion", async () => {
    const f = await categoryContextFixture("food_retail");
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Purchase" SET "spendingCategoryId"=NULL WHERE id=${f.purchase.id}`,
    );
    const live = await explainExpenseCategory(f.line);
    expect(fieldValueOf(live.envelope)).toBe(f.mapped.shortcode);
    expect(
      live.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Vendor default without a Product",
      )?.state,
    ).toEqual({ kind: "skipped", label: "Not applicable to this line" });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Product" SET "deletedAt"=CURRENT_TIMESTAMP WHERE id=${f.product.id}`,
    );
    const deleted = await explainExpenseCategory(f.line);
    expect(fieldValueOf(deleted.envelope)).toBeNull();
    expect(deleted.resolutionEvidence?.fallbackSource).toBeNull();
    expect(
      deleted.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Vendor default without a Product",
      )?.state,
    ).toEqual({ kind: "skipped", label: "Not applicable to this line" });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "Expense" SET "productId"=NULL WHERE id=${f.line.id}`,
    );
    const absent = await explainExpenseCategory(f.line);
    expect(fieldValueOf(absent.envelope)).toBe(f.contextual.shortcode);
    expect(absent.resolutionEvidence?.fallbackSource?.entityId).toBe(
      f.vendor.shortcode,
    );
    expect(
      absent.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Vendor default without a Product",
      )?.state?.kind,
    ).toBe("done");
  });

  it("explains unresolved receipt roles without inheriting assigned category alternatives", async () => {
    const f = await categoryContextFixture("restaurant");
    const unresolved = await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic unresolved receipt role",
      lineKind: "unclassified",
      date: "2026-09-01",
      cost: 100n,
      costType: "materials",
      purchaseId: f.purchase.id,
    });
    const explanation = await explainExpenseCategory(unresolved);
    expect(explanation.envelope.result).toMatchObject({
      kind: "live",
      decision: { outcome: { kind: "empty", reason: "not_applicable" } },
    });
    expect(explanation.resolutionEvidence?.fallbackSource).toBeNull();
    expect(
      explanation.resolutionEvidence?.chain.rows.find(
        (row) => row.id === f.purchase.shortcode,
      ),
    ).toMatchObject({
      trailing: "Synthetic deliberate purpose",
      state: { kind: "skipped", label: "Not applicable to this line" },
    });
    expect(
      explanation.resolutionEvidence?.chain.rows.some(
        (row) => row.state?.kind === "done",
      ),
    ).toBe(false);
  });

  it("explains mixed adjustment shares through each contributing principal", async () => {
    const project = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic shared project",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic share supplier",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      orderId: "SYNTHETIC-SHARES",
      vendorId: vendor.id,
      defaultProjectId: project.id,
      defaultTrade: "plumbing",
    });
    const first = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture first principal",
      purchaseId: purchase.id,
      lineKind: "principal",
      date: "2026-09-01",
      cost: 3000n,
      trade: "building",
      costType: "materials",
    });
    const second = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture second principal",
      purchaseId: purchase.id,
      lineKind: "principal",
      date: "2026-09-01",
      cost: 1000n,
      trade: "plumbing",
      costType: "services",
    });
    const adjustment = await insertWithShortcode(ctx.db, "expense", {
      name: "Fixture shared shipping",
      purchaseId: purchase.id,
      lineKind: "shipping",
      date: "2026-09-01",
      cost: 800n,
      costType: "materials",
    });
    const explanation = await explainField(context(), {
      entityKind: "expense",
      entityId: parseShortcodeFor("expense", adjustment.shortcode),
      field: "trade",
      surface: "list",
    });
    expect(explanation.envelope.result).toMatchObject({
      kind: "live",
      decision: { provenance: { kind: "allocated" } },
    });
    expect(explanation.resolutionEvidence?.outcome).toBe("mixed");
    expect(
      explanation.resolutionEvidence?.contributors
        ?.map((block) => block.chain.rows[0]?.id)
        .sort(),
    ).toEqual([first.shortcode, second.shortcode].sort());
    expect(
      explanation.resolutionEvidence?.contributors?.every((block) =>
        block.chain.rows.some((row) => row.state?.kind === "done"),
      ),
    ).toBe(true);
    expect(
      explanation.resolutionEvidence?.contributors
        ?.flatMap((block) => block.chain.rows[0]?.lines ?? [])
        .map((line) => line.text)
        .join(" "),
    ).toContain("positive");
    const projects = await explainField(context(), {
      entityKind: "expense",
      entityId: parseShortcodeFor("expense", adjustment.shortcode),
      field: "projectId",
      surface: "list",
    });
    expect(fieldValueOf(projects.envelope)).toBeNull();
    expect(projects.resolutionEvidence?.outcome).toBe("resolved");
    expect(
      projects.resolutionEvidence?.contributors?.map(
        (block) => block.chain.rows[0]?.trailing,
      ),
    ).toEqual(["Synthetic shared project", "Synthetic shared project"]);

    await updateExpense(ctx.db, first.shortcode, { trade: null }, ctx.actor);
    const refreshed = await explainField(context(), {
      entityKind: "expense",
      entityId: parseShortcodeFor("expense", adjustment.shortcode),
      field: "trade",
      surface: "list",
    });
    expect(fieldValueOf(refreshed.envelope)).toBe("plumbing");
    expect(refreshed.resolutionEvidence?.outcome).toBe("resolved");
    expect(
      await getDb(ctx.db).query.expense.findFirst({
        where: {
          RAW: (expense, { eq }) =>
            relationalSql(expense, eq(expense.id, first.id)),
        },
        columns: { trade: true },
      }),
    ).toEqual({ trade: null });
  });

  it("shows a reimbursement's stored policy as overridden rather than unset", async () => {
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic reimbursement account",
      identity: { kind: "cash" },
    });
    const transaction = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: account.id,
        amount: moneyToMinor(-10),
        kind: "income",
        status: "posted",
        postedDate: "2026-09-01",
        itemizationExpectation: "required",
      },
    );
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic reimbursed booking",
      lineKind: "principal",
      cost: -1000n,
      date: "2026-09-01",
      costType: "materials",
      trade: "other",
      economicRole: "reimbursement",
      lineBasis: "allocation",
      bookingTransactionCode: transaction.shortcode,
    });
    const explanation = await explainField(context(), {
      entityKind: "financialTransaction",
      entityId: parseShortcodeFor(
        "financialTransaction",
        transaction.shortcode,
      ),
      field: "itemizationExpectation",
      surface: "list",
    });
    expect(explanation.envelope).toMatchObject({
      current: {
        assignment: { kind: "value", value: "required" },
        controls: { kind: "readonly", reason: "allocated" },
      },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: "not_expected" },
          provenance: { kind: "allocated" },
        },
      },
    });
    expect(explanation.resolutionEvidence?.chain.rows[1]).toMatchObject({
      trailing: "Expected",
      state: { kind: "skipped", label: "Evaluated · overridden" },
    });
  });

  it("explains full linked policies behind transaction overrides and reviewed reimbursement", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic transaction policy category",
      itemizationExpectation: "not_expected",
    });
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic linked policy account",
      identity: { kind: "cash" },
    });
    const transaction = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: account.id,
        amount: moneyToMinor(2),
        kind: "purchase",
        status: "posted",
        postedDate: "2026-09-01",
        spendingCategoryId: category.id,
      },
    );
    const explain = () =>
      explainField(context(), {
        entityKind: "financialTransaction",
        entityId: parseShortcodeFor(
          "financialTransaction",
          transaction.shortcode,
        ),
        field: "itemizationExpectation",
        surface: "list",
      });
    const unlinked = await explain();
    expect(fieldValueOf(unlinked.envelope)).toBe("not_expected");
    expect(
      unlinked.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Linked Purchase policies",
      ),
    ).toMatchObject({ id: null, state: { kind: "skipped", label: "Not set" } });
    const supplier = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic linked policy vendor",
    });
    const purchaseRecord = await createRepoEntity(ctx, "purchase", {
      vendorId: supplier.output.id,
      orderId: "SYNTHETIC-LINKED-REQUIRED",
      itemizationExpectation: "required",
    });
    const purchase = {
      id: purchaseRecord.entityId,
      shortcode: purchaseRecord.output.id,
    };
    await getDb(ctx.db)
      .insert(financialTransactionAllocation)
      .values({
        transactionId: transaction.id,
        purchaseId: purchase.id,
        amountMinor: moneyToMinor(1),
      });
    const single = await explain();
    expect(single.envelope.result).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: "required" },
        provenance: {
          kind: "inherited",
          source: { entityId: purchase.shortcode },
        },
      },
    });
    expect(
      single.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Linked Purchase policies",
      ),
    ).toMatchObject({
      id: purchase.shortcode,
      trailing: "Expected",
      state: { kind: "done" },
    });
    const secondRecord = await createRepoEntity(ctx, "purchase", {
      vendorId: supplier.output.id,
      orderId: "SYNTHETIC-LINKED-UNKNOWN",
      itemizationExpectation: "unknown",
    });
    const second = {
      id: secondRecord.entityId,
      shortcode: secondRecord.output.id,
    };
    await getDb(ctx.db)
      .insert(financialTransactionAllocation)
      .values({
        transactionId: transaction.id,
        purchaseId: second.id,
        amountMinor: moneyToMinor(1),
      });
    const multiple = await explain();
    expect(multiple.envelope.result).toMatchObject({
      kind: "live",
      decision: {
        outcome: { kind: "value", value: "required" },
        provenance: { kind: "default", source: null },
      },
    });
    expect(
      multiple.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Linked Purchase policies",
      ),
    ).toMatchObject({
      id: null,
      trailing: "Expected",
      state: { kind: "done" },
    });
    await unwrapDb(ctx.db).execute(
      sql`UPDATE "FinancialTransaction" SET "itemizationExpectation"=${itemizationExpectation.enum.unknown} WHERE id=${transaction.id}`,
    );
    const overridden = await explain();
    expect(overridden.envelope).toMatchObject({
      current: { assignment: { kind: "value", value: "unknown" } },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: "unknown" },
          provenance: { kind: "own" },
        },
      },
    });
    expect(
      overridden.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Linked Purchase policies",
      ),
    ).toMatchObject({
      id: null,
      trailing: "Expected",
      state: { kind: "skipped", label: "Evaluated · overridden" },
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic linked policy reimbursement",
      lineKind: "principal",
      cost: -200n,
      date: "2026-09-01",
      costType: "materials",
      economicRole: "reimbursement",
      lineBasis: "allocation",
      bookingTransactionCode: transaction.shortcode,
    });
    const reimbursed = await explain();
    expect(reimbursed.envelope).toMatchObject({
      current: { controls: { kind: "readonly", reason: "allocated" } },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: "not_expected" },
          provenance: { kind: "allocated" },
        },
      },
    });
    expect(
      reimbursed.resolutionEvidence?.chain.rows.find(
        (row) => row.title === "Linked Purchase policies",
      ),
    ).toMatchObject({
      id: null,
      trailing: "Expected",
      state: { kind: "skipped", label: "Evaluated · overridden" },
    });
  });
});

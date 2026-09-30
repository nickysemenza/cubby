import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityKernelContextSchema } from "~/server/entity-kernel";
import { createTestRequestContext } from "~/server/testing/request-context";

import { unwrapDb } from "./database-helpers";
import {
  applyReviewedEvidencePolicies,
  previewReviewedEvidencePolicies,
} from "./reviewed-evidence-policies";
import { insertWithShortcode } from "./shortcode-utils";

// Rollout failures: preview writes, explicit policy overwritten, parent policy
// silently applied to children, higher-precedence unknown hidden, stale approval.
describe("reviewed evidence policy rollout", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
  it("previews effective precedence and applies only unclassified reviewed fields", async () => {
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture equipment",
    });
    await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Fixture equipment child",
      parentId: category.id,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture merchant",
      evidenceExpectation: "unknown",
    });
    const preserved = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture explicit merchant",
      evidenceExpectation: "not_expected",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      spendingCategoryId: category.id,
      date: "2026-09-01",
    });
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      spendingCategoryId: category.id,
      date: "2026-09-02",
      evidenceExpectation: "unknown",
    });
    const decisions = [
      {
        entity: "vendor" as const,
        id: vendor.shortcode,
        name: vendor.name,
        evidenceExpectation: "required" as const,
      },
      {
        entity: "vendor" as const,
        id: preserved.shortcode,
        name: preserved.name,
        evidenceExpectation: "required" as const,
      },
      {
        entity: "spendingCategory" as const,
        id: category.shortcode,
        name: category.name,
        productExpectation: "required" as const,
      },
    ];
    const preview = await previewReviewedEvidencePolicies(ctx.db, decisions);
    expect(preview.updates).toHaveLength(2);
    expect(preview.preservedFields).toBe(1);
    expect(preview.unreviewedChildren).toBe(1);
    expect(preview.blocked.purchaseOverrides).toBe(1);
    expect(preview.transitions["purchase.expectation:unknown->required"]).toBe(
      1,
    );
    expect(
      (
        await unwrapDb(ctx.db).execute(
          sql`SELECT "evidenceExpectation" FROM "Vendor" WHERE id = ${vendor.id}`,
        )
      ).rows[0]?.evidenceExpectation,
    ).toBe("unknown");
    await applyReviewedEvidencePolicies(
      context(),
      decisions,
      preview.fingerprint,
    );
    expect(
      (
        await unwrapDb(ctx.db).execute(
          sql`SELECT "evidenceExpectation" FROM "Vendor" WHERE id = ${preserved.id}`,
        )
      ).rows[0]?.evidenceExpectation,
    ).toBe("not_expected");
    expect(
      (
        await unwrapDb(ctx.db).execute(
          sql`SELECT count(*)::int AS count FROM "Expense"`,
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await unwrapDb(ctx.db).execute(
          sql`SELECT "evidenceExpectation" FROM "Purchase" WHERE id = ${purchase.id}`,
        )
      ).rows[0]?.evidenceExpectation,
    ).toBeNull();
    const replay = await previewReviewedEvidencePolicies(ctx.db, decisions);
    expect(replay.updates).toHaveLength(0);
  });
  it("refuses changed identity, stale graph approval, and rolls back a later failed kernel write", async () => {
    const first = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture first merchant",
      evidenceExpectation: "unknown",
    });
    const second = await insertWithShortcode(ctx.db, "vendor", {
      name: "Fixture second merchant",
      evidenceExpectation: "unknown",
    });
    const decisions = [first, second].map((v) => ({
      entity: "vendor" as const,
      id: v.shortcode,
      name: v.name,
      evidenceExpectation: "required" as const,
    }));
    const preview = await previewReviewedEvidencePolicies(ctx.db, decisions);
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: first.id,
      date: "2026-09-01",
    });
    await expect(
      applyReviewedEvidencePolicies(context(), decisions, preview.fingerprint),
    ).rejects.toThrow(/changed/);
    await expect(
      previewReviewedEvidencePolicies(ctx.db, [
        { ...decisions[0]!, name: "Fixture wrong identity" },
      ]),
    ).rejects.toThrow(/identity/);
    const fresh = await previewReviewedEvidencePolicies(ctx.db, decisions);
    await unwrapDb(ctx.db).execute(
      sql`ALTER TABLE "Vendor" ADD CONSTRAINT fixture_policy_refusal CHECK (shortcode <> ${sql.raw(`'${second.shortcode}'`)} OR "evidenceExpectation" <> 'required')`,
    );
    await expect(
      applyReviewedEvidencePolicies(context(), decisions, fresh.fingerprint),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "fixture_policy_refusal" },
    });
    expect(
      (
        await unwrapDb(ctx.db).execute(
          sql`SELECT "evidenceExpectation" FROM "Vendor" WHERE id = ${first.id}`,
        )
      ).rows[0]?.evidenceExpectation,
    ).toBe("unknown");
  });
});

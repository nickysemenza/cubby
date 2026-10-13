import { fieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { unwrapDb } from "./database-helpers";
import { getPurchaseByID } from "./purchase";
import { resolveDraftEvidenceFields } from "./purchase-evidence-policy";
import { resolveLiveShortcode } from "./shortcode-resolver";
import { insertWithShortcode } from "./shortcode-utils";

// Unsaved dependency changes must use live policy without materializing an
// inherited value, and an explicit unknown remains a deliberate override.
const ctx = withTestDb();
type DraftEvidenceBasis = Parameters<
  typeof resolveDraftEvidenceFields
>[1]["basis"];
it("preserves a saved multi-purchase policy until draft link intent explicitly changes", async () => {
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic draft allocation policies",
  });
  const required = await insertWithShortcode(ctx.db, "purchase", {
    vendorId: vendor.id,
    date: "2026-09-01",
    itemizationExpectation: "required",
  });
  const optional = await insertWithShortcode(ctx.db, "purchase", {
    vendorId: vendor.id,
    date: "2026-09-01",
    itemizationExpectation: "not_expected",
  });
  const account = await createRepoEntity(ctx, "financialAccount", {
    name: "Synthetic draft allocations",
    identity: { kind: "credit_card", issuer: null, network: "visa" },
  });
  const transaction = await createRepoEntity(ctx, "financialTransaction", {
    accountId: account.output.id,
    amount: 12,
    kind: "purchase",
    status: "posted",
    postedDate: "2026-09-01",
  });
  const id = await resolveLiveShortcode(
    ctx.db,
    transaction.output.id,
    "financialTransaction",
  );
  await unwrapDb(ctx.db).execute(
    sql`INSERT INTO "FinancialTransactionAllocation" ("transactionId","purchaseId",amount) VALUES (${id},${required.id},6),(${id},${optional.id},6)`,
  );
  const resolve = async (purchaseId: string | null, fields: string[]) =>
    fieldResolutionsSchema.parse(
      await resolveDraftEvidenceFields(ctx.db, {
        entity: "financialTransaction",
        entityId: transaction.output.id,
        basis: {
          purchaseId,
          itemizationExpectation: null,
          __draftFields: JSON.stringify(fields),
        },
      }),
    ).itemizationExpectation;
  expect(await resolve(null, [])).toMatchObject({
    value: "required",
    source: "linked purchase policies",
    sourceEntity: null,
  });
  expect(await resolve(null, ["purchaseId"])).toMatchObject({
    value: "unknown",
    sourceEntity: null,
  });
  expect(await resolve(optional.shortcode, ["purchaseId"])).toMatchObject({
    value: "not_expected",
    sourceEntity: { entityKind: "purchase", entityId: optional.shortcode },
  });
});
it("resolves an unsaved transaction purchase link and honors explicit clearing", async () => {
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic draft linkage",
    itemizationExpectation: "required",
  });
  const purchase = await insertWithShortcode(ctx.db, "purchase", {
    vendorId: vendor.id,
    date: "2026-09-01",
  });
  const resolve = async (purchaseId: string | null) =>
    fieldResolutionsSchema.parse(
      await resolveDraftEvidenceFields(ctx.db, {
        entity: "financialTransaction",
        basis: { purchaseId, itemizationExpectation: null },
      }),
    ).itemizationExpectation;
  expect(await resolve(purchase.shortcode)).toMatchObject({
    mode: "inherit",
    value: "required",
    fallbackValue: "required",
    sourceEntity: { entityKind: "purchase", entityId: purchase.shortcode },
  });
  expect(await resolve(null)).toMatchObject({
    mode: "inherit",
    value: "unknown",
    fallbackValue: "unknown",
    sourceEntity: null,
  });
});
it("resolves draft itemization policy against changed vendor and category dependencies without writes", async () => {
  const category = await insertWithShortcode(ctx.db, "spendingCategory", {
    name: "Synthetic required receipts",
    itemizationExpectation: "required",
  });
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic optional receipts",
    itemizationExpectation: "not_expected",
  });
  const purchase = await insertWithShortcode(ctx.db, "purchase", {
    vendorId: vendor.id,
    spendingCategoryId: category.id,
    date: "2026-09-01",
  });
  const basis: DraftEvidenceBasis = {
    vendorId: vendor.shortcode,
    spendingCategoryId: category.shortcode,
    itemizationExpectation: null,
  };
  const resolve = (next: typeof basis) =>
    resolveDraftEvidenceFields(ctx.db, {
      entity: "purchase",
      entityId: purchase.shortcode,
      basis: next,
    });
  expect(
    fieldResolutionsSchema.parse(await resolve(basis)).itemizationExpectation,
  ).toMatchObject({
    mode: "inherit",
    storedValue: null,
    value: "not_expected",
    fallbackValue: "not_expected",
    sourceEntity: { entityKind: "vendor", entityId: vendor.shortcode },
    canReset: false,
  });
  expect(
    fieldResolutionsSchema.parse(await resolve({ ...basis, vendorId: null }))
      .itemizationExpectation,
  ).toMatchObject({
    mode: "inherit",
    value: "required",
    sourceEntity: {
      entityKind: "spendingCategory",
      entityId: category.shortcode,
    },
  });
  expect(
    fieldResolutionsSchema.parse(
      await resolveDraftEvidenceFields(ctx.db, {
        entity: "purchase",
        entityId: purchase.shortcode,
        basis: { ...basis, itemizationExpectation: "unknown" },
      }),
    ).itemizationExpectation,
  ).toMatchObject({
    mode: "explicit",
    storedValue: "unknown",
    value: "unknown",
    fallbackValue: "not_expected",
    canReset: true,
  });
  expect(await getPurchaseByID(ctx.db, purchase.id)).toMatchObject({
    vendorId: parseShortcodeFor("vendor", vendor.shortcode),
    itemizationExpectation: null,
  });
  expect(
    fieldResolutionsSchema.parse(
      await resolveDraftEvidenceFields(ctx.db, {
        entity: "financialTransaction",
        basis: {
          purchaseId: purchase.shortcode,
          itemizationExpectation: null,
        },
      }),
    ).itemizationExpectation,
  ).toMatchObject({
    mode: "inherit",
    storedValue: null,
    value: "not_expected",
    fallbackValue: "not_expected",
    sourceEntity: {
      entityKind: "purchase",
      entityId: purchase.shortcode,
    },
  });
});

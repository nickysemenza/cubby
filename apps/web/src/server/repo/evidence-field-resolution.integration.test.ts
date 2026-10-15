import { fieldExplanationOutput } from "@cubby/schemas/field-explanation";
import { fieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { contributionRole } from "@cubby/schemas/ledger-party";
import { sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { unwrapDb } from "./database-helpers";
import { loadFieldResolutionEvidence } from "./field-resolution-evidence";
import {
  inventoryOwnerResolution,
  loadInventoryOwnershipTraces,
} from "./inventory/ownership";
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

// A blocked beneficiary must never promote a lower account default to Used;
// evidence must retain every inventory branch and disclose bounded coverage.
it("explains a blocking beneficiary and evaluated account alternatives without a false winner", async () => {
  const person = await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic individual",
    kind: "member",
  });
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic ownership vendor",
  });
  const account = await insertWithShortcode(ctx.db, "vendorAccount", {
    vendorId: vendor.id,
    label: "Synthetic account",
    ledgerPartyId: person.id,
    inventoryOwnerDefaultEnabled: true,
  });
  const product = await insertWithShortcode(ctx.db, "product", {
    manufacturer: "Synthetic maker",
    name: "Synthetic ownership product",
  });
  const purchase = await insertWithShortcode(ctx.db, "purchase", {
    vendorId: vendor.id,
    vendorAccountId: account.id,
    date: "2026-09-01",
  });
  const line = await insertWithShortcode(ctx.db, "expense", {
    costType: "materials",
    lineKind: "principal",
    name: "Synthetic acquisition",
    productId: product.id,
    purchaseId: purchase.id,
    date: "2026-09-01",
    cost: 10,
  });
  await unwrapDb(ctx.db).execute(
    sql`INSERT INTO "ExpenseAttribution" ("expenseId",role,"ledgerPartyId",weight) VALUES (${line.id},${contributionRole.enum.beneficiary},NULL,1)`,
  );
  const namedLine = await insertWithShortcode(ctx.db, "expense", {
    lineKind: "principal",
    costType: "materials",
    name: "Synthetic named acquisition line",
    productId: product.id,
    purchaseId: purchase.id,
    date: "2026-09-01",
    cost: 5,
  });
  await unwrapDb(ctx.db).execute(
    sql`INSERT INTO "ExpenseAttribution" ("expenseId",role,"ledgerPartyId",weight) VALUES (${namedLine.id},${contributionRole.enum.beneficiary},${person.id},1)`,
  );
  const result = await loadFieldResolutionEvidence(
    ctx.db,
    "product",
    product.shortcode,
    "owners",
    null,
  );
  expect(() =>
    fieldExplanationOutput.shape.resolutionEvidence.parse(result.evidence),
  ).not.toThrow();
  expect(result.evidence?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "inherited_beneficiary",
        reason: "beneficiary_unresolved",
        effect: "blocked",
      }),
      expect.objectContaining({
        source: "inherited_vendor_account",
        reason: "vendor_enabled",
        effect: "overridden",
      }),
    ]),
  );
  expect(
    result.evidence?.chain.rows.some(
      (row) =>
        row.title === "Vendor account default" && row.state?.label === "Used",
    ),
  ).toBe(false);
  expect(
    result.evidence?.chain.rows.find(
      (row) => row.title === "Vendor account default",
    )?.lines,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        text: expect.stringContaining("Synthetic individual"),
      }),
    ]),
  );
  await unwrapDb(ctx.db).execute(
    sql`UPDATE "ExpenseAttribution" SET "ledgerPartyId" = NULL WHERE "expenseId" = ${namedLine.id}`,
  );
  const unknown = await loadFieldResolutionEvidence(
    ctx.db,
    "product",
    product.shortcode,
    "owners",
    null,
  );
  expect(unknown.evidence?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "inherited_beneficiary",
        reason: "beneficiary_unknown",
        effect: "fallback",
      }),
      expect.objectContaining({
        source: "inherited_vendor_account",
        effect: "used",
      }),
    ]),
  );
});

it("distinguishes no acquisition, multiple acquisitions, and explicit Household from unknown", async () => {
  const product = await insertWithShortcode(ctx.db, "product", {
    manufacturer: "Synthetic maker",
    name: "Synthetic missing acquisition",
  });
  const empty = await loadFieldResolutionEvidence(
    ctx.db,
    "product",
    product.shortcode,
    "owners",
    null,
  );
  expect(empty.evidence?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: "acquisition_absent" }),
    ]),
  );
  for (const name of [
    "Synthetic first acquisition",
    "Synthetic second acquisition",
  ])
    await insertWithShortcode(ctx.db, "expense", {
      costType: "materials",
      lineKind: "principal",
      name,
      productId: product.id,
      date: "2026-09-01",
      cost: 1,
    });
  const multiple = await loadFieldResolutionEvidence(
    ctx.db,
    "product",
    product.shortcode,
    "owners",
    null,
  );
  expect(multiple.evidence?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        reason: "acquisition_multiple",
        effect: "blocked",
      }),
    ]),
  );
  const location = await insertWithShortcode(ctx.db, "location", {
    type: "room",
    name: "Synthetic ownership shelf",
  });
  const entry = await insertWithShortcode(ctx.db, "inventory", {
    productId: product.id,
    locationId: location.id,
    amountValue: 1,
    amountUnit: "each",
    ownershipMode: "explicit",
    ownerLedgerPartyId: null,
  });
  const trace = (await loadInventoryOwnershipTraces(ctx.db, [entry])).get(
    entry.id,
  )!;
  const evidence = await loadFieldResolutionEvidence(
    ctx.db,
    "inventory",
    entry.shortcode,
    "ownerLedgerPartyId",
    inventoryOwnerResolution(trace.ownership, trace.steps),
  );
  expect(evidence.evidence?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: "household", effect: "used" }),
    ]),
  );
  const person = await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic explicit individual",
    kind: "member",
  });
  const explicitLocation = await insertWithShortcode(ctx.db, "location", {
    name: "Synthetic explicit shelf",
    type: "room",
  });
  const explicit = await insertWithShortcode(ctx.db, "inventory", {
    productId: product.id,
    locationId: explicitLocation.id,
    amountValue: 1,
    amountUnit: "each",
    ownershipMode: "explicit",
    ownerLedgerPartyId: person.id,
  });
  const inheritLocation = await insertWithShortcode(ctx.db, "location", {
    name: "Synthetic inheriting shelf",
    type: "room",
  });
  const inherited = await insertWithShortcode(ctx.db, "inventory", {
    productId: product.id,
    locationId: inheritLocation.id,
    amountValue: 1,
    amountUnit: "each",
  });
  const branches = (
    await loadFieldResolutionEvidence(
      ctx.db,
      "product",
      product.shortcode,
      "owners",
      null,
    )
  ).evidence;
  expect(branches?.branches).toEqual({ total: 3, shown: 3, omitted: 0 });
  expect(branches?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        branch: { entityKind: "inventory", entityId: entry.shortcode },
        reason: "household",
        effect: "used",
      }),
      expect.objectContaining({
        branch: { entityKind: "inventory", entityId: explicit.shortcode },
        reason: "explicit",
        effect: "used",
      }),
      expect.objectContaining({
        branch: { entityKind: "inventory", entityId: inherited.shortcode },
        reason: "inherit",
        effect: "fallback",
      }),
      expect.objectContaining({
        branch: { entityKind: "inventory", entityId: inherited.shortcode },
        reason: "acquisition_multiple",
        effect: "blocked",
      }),
      expect.objectContaining({
        branch: { entityKind: "inventory", entityId: explicit.shortcode },
        reason: "acquisition_multiple",
        effect: "overridden",
      }),
    ]),
  );
});

it("reports omitted ownership branches and keeps the full stack for each included entry", async () => {
  const product = await insertWithShortcode(ctx.db, "product", {
    manufacturer: "Synthetic maker",
    name: "Synthetic many-entry product",
  });
  for (let index = 0; index < 51; index++) {
    const location = await insertWithShortcode(ctx.db, "location", {
      type: "room",
      name: `Synthetic shelf ${index}`,
    });
    await insertWithShortcode(ctx.db, "inventory", {
      productId: product.id,
      locationId: location.id,
      amountValue: 1,
      amountUnit: "each",
    });
  }
  const result = await loadFieldResolutionEvidence(
    ctx.db,
    "product",
    product.shortcode,
    "owners",
    null,
  );
  expect(result.truncated).toBe(true);
  expect(result.evidence?.branches).toEqual({
    total: 51,
    shown: 50,
    omitted: 1,
  });
  expect(
    result.evidence?.steps?.filter(
      (step) => step.reason === "acquisition_absent",
    ),
  ).toHaveLength(50);
});

it("shows disabled account parties, payment agreement, and enabled unusable vendor blocking", async () => {
  const person = await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic account party",
    kind: "member",
  });
  const other = await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic second party",
    kind: "member",
  });
  const shared = await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic shared party",
    kind: "household",
  });
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic policy vendor",
  });
  const vendorAccount = await insertWithShortcode(ctx.db, "vendorAccount", {
    vendorId: vendor.id,
    label: "Synthetic vendor policy",
    ledgerPartyId: person.id,
    inventoryOwnerDefaultEnabled: false,
  });
  const product = await insertWithShortcode(ctx.db, "product", {
    name: "Synthetic policy product",
    manufacturer: "Synthetic maker",
  });
  const purchase = await insertWithShortcode(ctx.db, "purchase", {
    vendorId: vendor.id,
    vendorAccountId: vendorAccount.id,
    date: "2026-09-01",
  });
  await insertWithShortcode(ctx.db, "expense", {
    name: "Synthetic policy acquisition",
    productId: product.id,
    purchaseId: purchase.id,
    date: "2026-09-01",
    cost: 10,
    costType: "materials",
    lineKind: "principal",
  });
  const firstAccount = await createRepoEntity(ctx, "financialAccount", {
    name: "Synthetic enabled account",
    ledgerPartyId: person.shortcode,
    inventoryOwnerDefaultEnabled: true,
  });
  const secondAccount = await createRepoEntity(ctx, "financialAccount", {
    name: "Synthetic disabled account",
    ledgerPartyId: other.shortcode,
    inventoryOwnerDefaultEnabled: false,
  });
  for (const account of [firstAccount, secondAccount]) {
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      amount: 5,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-01",
    });
    await unwrapDb(ctx.db).execute(
      sql`INSERT INTO "FinancialTransactionAllocation" ("transactionId","purchaseId",amount) VALUES (${transaction.entityId},${purchase.id},5)`,
    );
  }
  const evidence = async () =>
    (
      await loadFieldResolutionEvidence(
        ctx.db,
        "product",
        product.shortcode,
        "owners",
        null,
      )
    ).evidence;
  const initial = await evidence();
  expect(initial?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        reason: "beneficiary_absent",
        effect: "fallback",
      }),
      expect.objectContaining({
        reason: "vendor_disabled",
        effect: "fallback",
        observed: [
          expect.objectContaining({
            entity: {
              entityKind: "vendorAccount",
              entityId: vendorAccount.shortcode,
            },
            value: expect.objectContaining({
              inventoryOwnerDefaultEnabled: false,
              party: expect.objectContaining({ id: person.shortcode }),
            }),
          }),
        ],
      }),
      expect.objectContaining({
        reason: "payment_disabled",
        effect: "blocked",
        observed: expect.arrayContaining([
          expect.objectContaining({
            entity: {
              entityKind: "financialAccount",
              entityId: secondAccount.output.id,
            },
            value: expect.objectContaining({
              inventoryOwnerDefaultEnabled: false,
              party: expect.objectContaining({ id: other.shortcode }),
            }),
          }),
        ]),
      }),
    ]),
  );
  await unwrapDb(ctx.db).execute(
    sql`UPDATE "FinancialAccount" SET "inventoryOwnerDefaultEnabled"=true WHERE id=${secondAccount.entityId}`,
  );
  expect((await evidence())?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        reason: "payment_conflict",
        effect: "blocked",
      }),
    ]),
  );
  await unwrapDb(ctx.db).execute(
    sql`UPDATE "FinancialAccount" SET "ledgerPartyId"=${person.id} WHERE id=${secondAccount.entityId}`,
  );
  expect((await evidence())?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: "payment_agreement", effect: "used" }),
    ]),
  );
  await unwrapDb(ctx.db).execute(
    sql`UPDATE "VendorAccount" SET "inventoryOwnerDefaultEnabled"=true,"ledgerPartyId"=${shared.id} WHERE id=${vendorAccount.id}`,
  );
  expect((await evidence())?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: "vendor_unusable", effect: "blocked" }),
      expect.objectContaining({
        reason: "payment_agreement",
        effect: "overridden",
      }),
    ]),
  );
  await unwrapDb(ctx.db).execute(
    sql`UPDATE "VendorAccount" SET "ledgerPartyId"=${person.id} WHERE id=${vendorAccount.id}`,
  );
  expect((await evidence())?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: "vendor_enabled", effect: "used" }),
    ]),
  );
});

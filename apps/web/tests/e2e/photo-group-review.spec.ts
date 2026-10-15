import { startOperation } from "./start-operation";
import type { Fixture as TestGatewayFixture } from "./harness-services/purchase-import-test-gateway";
import {
  seedProductPrerequisite,
  seedInventoryPrerequisites,
} from "./fixtures-catalog";
import { and, eq } from "drizzle-orm";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { TestHarness } from "wrangler";
import { memberImport } from "~/server/purchase-import/order-import.fixtures";
import {
  prepareSourceOrderReconciliation,
  commitAcceptedSourceOrderReconciliation,
} from "~/server/purchase-import/reconciliation";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import * as schema from "~/server/db/schema";
import {
  createEvidenceHarnessContext,
  createEntityFixture,
} from "./fixtures-core";
import {
  seedPhotoGroupReviewRun,
  seedPhotoReviewProcessingFailure,
  seedPhotoReviewLabelText,
} from "./fixtures-photos";
import { openDetailActions, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, recordingVideo, test } from "./e2e-test";

async function configureVariantDecisions(
  harness: TestHarness,
  decisions: NonNullable<TestGatewayFixture["decisions"]>,
) {
  const response = await harness
    .getWorker("cubby-test-gateway")
    .fetch("https://gateway.test/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decisions }),
    });
  expect(response.status).toBe(204);
}

test.beforeEach(async ({ e2eRuntime }) => {
  await configureVariantDecisions(e2eRuntime.harness, []);
});

test.afterEach(async ({ e2eRuntime }) => {
  await configureVariantDecisions(e2eRuntime.harness, []);
});

// Applying historical evidence must neither receive stock nor replace fields
// the reviewer did not select. An unresolved proposal and a fractional count
// cannot be applied using an older saved payload.
test("resolves identity, validates counts, and applies selected fields without receiving historical stock", async ({
  page,
  e2eRuntime,
}) => {
  const name = `Synthetic review ${Date.now()}`;
  const existing = await createEntityFixture(page, "product", {
    name: `${name} shirt`,
    notes: "Original catalog notes",
  });
  const seed = await seedPhotoGroupReviewRun(
    page,
    name,
    e2eRuntime.objectStorageUrl,
  );
  const incompatibleStock = await createEntityFixture(page, "inventory", {
    productId: existing.id,
    locationId: seed.location.id,
    amount: { value: 2, unit: "kg" },
  });
  const proposed = await startOperation(
    page.request,
    "photoImport.saveGroups",
    {
      runId: seed.runId,
      groups: [
        {
          ...seed.groups[0]!,
          product: { kind: "existing", existingId: existing.id },
          review: {
            observedName: "Blue cotton shirt",
            unresolvedReason: "Confirm the label size",
            stockIntent: "receive",
          },
        },
        seed.groups[1]!,
      ],
    },
  );
  expect(proposed.ok(), await proposed.text()).toBeTruthy();
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#photo-group-g1`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const other = page.locator("#photo-group-g2");
  await other.scrollIntoViewIfNeeded();
  await other.getByRole("combobox", { name: "stock decision" }).click();
  await page
    .getByRole("option", { name: "Receive newly counted stock", exact: true })
    .click();
  await expect(
    other.getByText("Choose a location before receiving stock."),
  ).toBeVisible();
  await expect(
    other.getByRole("button", { name: "Create Product", exact: true }),
  ).toBeDisabled();
  await other.getByRole("combobox", { name: "stock decision" }).click();
  await page
    .getByRole("option", { name: "Catalog evidence only", exact: true })
    .click();
  const group = page.locator("#photo-group-g1");
  await expect(
    group.getByRole("button", { name: "Attach photos", exact: true }),
  ).toBeDisabled();
  await group
    .getByRole("button", { name: "Confirm identity", exact: true })
    .click();
  // A failed existing-entry selection can be replaced with a fresh count.
  await group.getByRole("combobox", { name: "existing stock entry" }).click();
  await page
    .getByRole("option")
    .filter({ hasText: `${name} shirt` })
    .first()
    .click();
  await expect(
    group.getByText("Retry the stock-entry selection before applying"),
  ).toBeVisible();
  await group
    .getByRole("button", { name: "Create a fresh count here", exact: true })
    .click();
  await expect(
    group.getByText("Retry the stock-entry selection before applying"),
  ).toHaveCount(0);
  const quantity = group.getByRole("spinbutton", { name: "Qty" });
  await quantity.fill("1.5");
  await group
    .getByRole("button", { name: "Attach photos", exact: true })
    .click();
  await expect(
    group.getByText("Enter a whole number greater than 0."),
  ).toBeVisible();
  await expect(
    group.getByRole("button", { name: "Attach photos", exact: true }),
  ).toBeVisible();
  await quantity.fill("1");
  await quantity.blur();
  await group.getByRole("combobox", { name: "stock decision" }).click();
  await page
    .getByRole("option", {
      name: "Historical or sold · no stock change",
      exact: true,
    })
    .click();
  await group.getByText(/Optional Product changes/).click();
  await group
    .getByRole("checkbox", { name: "Change name", exact: true })
    .check();
  const editedName = group.getByRole("textbox", {
    name: "New name",
    exact: true,
  });
  await editedName.fill("x".repeat(501));
  await editedName.blur();
  await expect(page.getByText(/Changes were not saved:/)).toBeVisible();
  await group
    .getByRole("checkbox", { name: "Change notes", exact: true })
    .check();
  await group
    .getByRole("textbox", { name: "New notes", exact: true })
    .fill("Label confirmed: medium");
  await group.getByRole("textbox", { name: "New notes", exact: true }).blur();
  await group
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await expect(editedName).toBeFocused();
  await expect(
    group.getByRole("button", { name: "Apply changes", exact: true }),
  ).toBeVisible();
  // Reverting the failed field to its saved value must unblock this group.
  await editedName.fill(`${name} shirt`);
  await group
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await group
    .getByRole("heading", { name: `Approved · ${name} shirt`, exact: true })
    .click();
  await expect(
    group.getByText("No Inventory write", { exact: true }),
  ).toBeVisible();
  const context = await createEvidenceHarnessContext(page);
  const db = getDb(context.db);
  const product = await db.query.product.findFirst({
    where: eq(schema.product.shortcode, existing.id),
  });
  expect(product).toMatchObject({
    name: `${name} shirt`,
    notes: "Label confirmed: medium",
  });
  const stock = await db.query.inventoryEntry.findMany({
    where: eq(schema.inventoryEntry.productId, product!.id),
  });
  expect(stock).toHaveLength(1);
  expect(stock[0]?.shortcode).toBe(incompatibleStock.id);
  await expect(
    page.getByRole("navigation", { name: "Section index" }),
  ).toHaveCount(1);
  await expect(
    page.getByText("Run cost · includes all nested work"),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/cubby-photo-review-fa0dc45b-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 402, height: 874 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: "/tmp/cubby-photo-review-fa0dc45b-mobile.png",
    fullPage: true,
  });
  // The optional editor primed this Product's detail cache before applying.
  // Following its result link must show the committed fields immediately.
  await group
    .getByRole("link", { name: `${name} shirt`, exact: true })
    .first()
    .click();
  await expect(
    page.getByText("Label confirmed: medium", { exact: true }),
  ).toBeVisible();
});

test("approves two selected photo groups with one reviewed batch action", async ({
  page,
  e2eRuntime,
}) => {
  const seed = await seedPhotoGroupReviewRun(
    page,
    `Selected batch ${Date.now()}`,
    e2eRuntime.objectStorageUrl,
  );
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#work`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const proposed = await startOperation(
    page.request,
    "photoImport.saveGroups",
    {
      runId: seed.runId,
      groups: seed.groups,
    },
  );
  expect(proposed.ok(), await proposed.text()).toBeTruthy();

  // Reviewing a batch must not require switching a single mounted editor;
  // selecting all still goes through the explicit, revision-checked approval.
  await expect(
    page.getByRole("heading", { name: /Gray crew t-shirt/ }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /solo find/ })).toBeAttached();
  await page.getByRole("button", { name: "Select all resolved items" }).click();
  await expect(
    page.getByRole("checkbox", { name: /Select Gray crew t-shirt/ }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: /Select .* solo find/ }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Apply 2 selected items" }).click();

  await expect(
    page.getByText("0 to review · 2 settled · 0 photos not in a group", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Section index" })
      .getByRole("link", { name: /^Applied ·/ }),
  ).toHaveCount(2);
  await expect(
    page
      .getByLabel("Products from this import")
      .getByText("Created by this import", { exact: true }),
  ).toHaveCount(2);
});

test("reviews, approves, and discards proposed photo groups on the photo-inventory run page", async ({
  page,
  e2eRuntime,
}) => {
  const name = `Photo run ${Date.now()}`;
  const seed = await seedPhotoGroupReviewRun(
    page,
    name,
    e2eRuntime.objectStorageUrl,
  );
  const g2Name = `${name} solo find`;

  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#work`,
    page.getByRole("heading", { name: "Photo review" }),
  );

  await openDetailActions(page);
  const actions = page.getByRole("group", {
    name: "Entity actions",
    exact: true,
  });
  await expect(
    actions.getByRole("button", { name: "Start grouping" }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  if (recordingVideo) await page.waitForTimeout(1_500);
  const proposed = await startOperation(
    page.request,
    "photoImport.saveGroups",
    {
      runId: seed.runId,
      groups: seed.groups,
    },
  );
  expect(proposed.ok(), await proposed.text()).toBeTruthy();

  // Both proposed groups render, and every seeded photo is assigned to one.
  await expect(
    page.getByText("2 to review · 0 settled · 0 photos not in a group", {
      exact: true,
    }),
  ).toBeVisible();
  await openDetailActions(page);
  await expect(
    page.getByRole("button", { name: "Start grouping" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  const g1Card = page.locator('[data-slot="card"]').filter({
    has: page.getByRole("heading", { name: "Gray crew t-shirt — M" }),
  });
  await expect(g1Card).toBeVisible();
  await expect(g1Card.getByText("Item", { exact: true })).toBeVisible();
  await expect(g1Card.getByText("Skipped", { exact: true })).toBeVisible();
  await g1Card
    .getByRole("button", { name: `Photo ${seed.labelImage.shortcode} actions` })
    .click();
  await page.getByRole("menuitem", { name: "Mark as label photo" }).click();
  await expect(g1Card.getByText("Label", { exact: true })).toBeVisible();
  await expect
    .poll(async () =>
      g1Card
        .locator('img[alt^="IMG-"]')
        .evaluateAll(
          (images) =>
            images.filter(
              (image) =>
                image instanceof HTMLImageElement &&
                image.complete &&
                image.naturalWidth > 0,
            ).length,
        ),
    )
    .toBe(2);

  await expect(
    page
      .getByRole("navigation", { name: "Section index" })
      .getByRole("link", { name: new RegExp(g2Name) }),
  ).toBeVisible();
  if (recordingVideo) await page.waitForTimeout(1_500);

  await g1Card
    .getByRole("combobox", { name: "category" })
    .fill(`${name} apparel`);
  await page.getByRole("option", { name: `${name} apparel` }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/photoImport/review?runId=${seed.runId}`,
      );
      const body = await response.json();
      return body.review.proposals.find(
        (proposal: { groupKey: string }) => proposal.groupKey === "g1",
      )?.product.create.categoryId;
    })
    .toBe(seed.category.id);
  if (recordingVideo) await page.waitForTimeout(1_500);

  // The Photos table lists every seeded image.
  const photosCard = page.getByRole("region", { name: "Run photos" });
  await expect(
    photosCard.getByRole("link", { name: /^Open photo / }),
  ).toHaveCount(3);

  // Blurring the edited name and clicking Approve in the same gesture must
  // save the correction before creating the Product.
  const correctedName = "Gray crew t-shirt — size M";
  await g1Card
    .getByRole("textbox", { name: "New product name" })
    .fill(correctedName);
  await g1Card
    .getByRole("button", {
      name: /^(Create Product|Attach photos|Apply changes)$/,
    })
    .click();
  await expect(
    page
      .locator("#photo-batch")
      .getByRole("link", { name: correctedName, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Section index" })
      .getByRole("link", { name: /^Applied ·/ }),
  ).toBeVisible();
  if (recordingVideo) await page.waitForTimeout(1_500);

  // Discard G2: nothing is left pending and the run completes.
  await page
    .getByRole("navigation", { name: "Section index" })
    .getByRole("link", { name: new RegExp(g2Name) })
    .click();
  const g2Card = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole("heading", { name: g2Name }) });
  await g2Card.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Section index" })
      .getByRole("link", { name: /^Discarded ·/ }),
  ).toBeVisible();
  await expect(
    page.getByText("Every proposed group has been approved or discarded.", {
      exact: true,
    }),
  ).toBeVisible();
  // The generic Run page's hero chip (and Overview) read the Run record,
  // refreshed once the live run poll sees the new status.
  await expect(
    page.getByText("Completed", { exact: true }).first(),
  ).toBeVisible({ timeout: 10_000 });
  await openDetailActions(page);
  await page
    .getByRole("button", { name: "Start new run with same inputs" })
    .click();
  await expect(page).not.toHaveURL(new RegExp(`/runs/${seed.runId}(?:#|$)`));
  const restartedId = new URL(page.url()).pathname.split("/").at(-1);
  expect(restartedId).toBeTruthy();
  const restarted = await page.request.get(
    `/api/v1/run/work?runId=${restartedId}`,
  );
  expect(restarted.ok(), await restarted.text()).toBeTruthy();
  const restartedRun = await restarted.json();
  expect(restartedRun.predecessorRunPublicId).toBe(seed.runId);
  expect(restartedRun.targets).toHaveLength(3);
  expect(
    restartedRun.targets.every(
      (target: { targetType: string }) => target.targetType === "image",
    ),
  ).toBe(true);
  if (recordingVideo) await page.waitForTimeout(1_500);
});

test("suggests an existing variant and previews every merge decision for a created photo product", async ({
  page,
  e2eRuntime,
}) => {
  const name = `Photo match ${Date.now()}`;
  const candidateName = `Gray crew t-shirt M ${name}`;
  const createdName = `Gray crew t-shirt — M ${name}`;
  const existing = await seedProductPrerequisite(page, { name: candidateName });
  const seed = await seedPhotoGroupReviewRun(
    page,
    name,
    e2eRuntime.objectStorageUrl,
  );
  seed.groups[0]!.product = {
    kind: "create",
    create: { name: createdName },
  };
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#work`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  await configureVariantDecisions(e2eRuntime.harness, [
    {
      feature: "product-variant-relation",
      match: createdName,
      label: "color same; size same",
    },
  ]);
  const proposed = await startOperation(
    page.request,
    "photoImport.saveGroups",
    {
      runId: seed.runId,
      groups: seed.groups,
    },
  );
  expect(proposed.ok(), await proposed.text()).toBeTruthy();

  const group = page.locator('[data-slot="card"]').filter({
    has: page.getByRole("heading", { name: createdName }),
  });
  await group.getByText("Compare existing Products", { exact: true }).click();
  await group
    .getByRole("button", { name: "Check existing Products", exact: true })
    .click();
  await expect
    .poll(async () => {
      const usage = await page.request.get(
        `/api/v1/run/aiUsage?runId=${seed.runId}&limit=1`,
      );
      expect(usage.ok(), await usage.text()).toBeTruthy();
      return (await usage.json()).count;
    })
    .toBeGreaterThan(0);
  await expect(
    group.getByRole("link", { name: candidateName, exact: true }),
  ).toBeVisible();
  await expect(
    group
      .locator("[data-record-list]")
      .locator(".ledger-row")
      .filter({ has: page.getByRole("link", { name: candidateName }) })
      .getByText(/Titles agree/)
      .first(),
  ).toBeVisible();
  await group
    .getByRole("button", {
      name: /^(Create Product|Attach photos|Apply changes)$/,
    })
    .click();
  // The run's connections panel links the created Product too.
  await expect(
    page.getByRole("heading", { name: `Approved · ${createdName}` }),
  ).toBeVisible();
  let createdId: string | undefined;
  await expect
    .poll(async () => {
      const review = await page.request.get(
        `/api/v1/photoImport/review?runId=${seed.runId}`,
      );
      if (!review.ok()) throw new Error(await review.text());
      const body = await review.json();
      createdId = body.review.proposals.find(
        (item: { groupKey: string }) => item.groupKey === "g1",
      )?.committedProduct?.id;
      return createdId;
    })
    .toBeTruthy();

  expect(createdId).toBeTruthy();
  const evidence =
    "Synthetic photo and retained retailer page show the same crew shirt and size.";
  const match = await startOperation(
    page.request,
    "recommendations.proposeProductMatch",
    {
      productIds: [existing.id, createdId!],
      evidence,
      sourceUrls: ["https://retailer.example/crew-shirt"],
    },
  );
  expect(match.ok(), await match.text()).toBeTruthy();
  await page
    .getByRole("heading", { name: `Approved · ${createdName}` })
    .click();
  await page.getByText("Review possible matches", { exact: true }).click();
  await page.getByText("Compare existing Products", { exact: true }).click();
  await page
    .getByRole("button", { name: "Check existing Products", exact: true })
    .click();
  await page.locator(`a[href*="candidate=${existing.id}"]`).click();
  await expect(page).toHaveURL(/recommendations\/workbench/);
  await expect(page.getByText(candidateName).first()).toBeVisible();
  await expect(page.getByText(evidence)).toBeVisible();
  await page.getByRole("button", { name: "Review merge" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "What the merged product will keep" }),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) < 768) {
    const decisions = dialog.getByTestId("product-merge-mobile-decisions");
    await expect(decisions).toBeVisible();
    await expect(decisions).toContainText(createdName);
    await expect(decisions).toContainText("Merge both");
    await expect(decisions).toContainText("1 image");
  } else {
    await expect(dialog.getByRole("row", { name: /Name/ })).toContainText(
      createdName,
    );
    await expect(dialog.getByRole("row", { name: /Images/ })).toContainText(
      "1 image",
    );
  }
  expect(existing.id).not.toBe(createdId);
});

test("reviews an occupied location and links a chosen unlinked Expense after photo approval", async ({
  page,
  e2eRuntime,
}) => {
  const name = `Photo decision ${Date.now()}`;
  const existingName = `Gray crew t-shirt M ${name}`;
  const stock = await seedInventoryPrerequisites(page, {
    locationName: `${name} shelf`,
    products: [{ name: existingName, quantity: 2, unit: "each" }],
  });
  const context = await createEvidenceHarnessContext(page);
  const db = getDb(context.db);
  const member = await db.query.ledgerParty.findFirst({
    where: and(
      eq(schema.ledgerParty.userId, context.actor.userId),
      eq(schema.ledgerParty.kind, "member"),
    ),
  });
  if (!member) {
    await insertWithShortcode(context.db, "ledgerParty", {
      kind: "member",
      userId: context.actor.userId,
      name: `Synthetic reviewer ${name}`,
    });
  }
  const merchant = `Synthetic photo retailer ${name}`;
  const vendor = await createEntityFixture(page, "vendor", { name: merchant });
  const sourceKey = `synthetic:photo-link:${crypto.randomUUID()}`;
  await memberImport(context.db, context.actor, {
    key: sourceKey,
    orders: [
      {
        stableOrderId: sourceKey,
        vendorId: parseShortcodeFor("vendor", vendor.id),
        source: {
          kind: "receipt_photo",
          externalKey: sourceKey,
          checksum: "b".repeat(64),
        },
        extraction: {
          status: "ready",
          candidate: {
            orderId: sourceKey,
            orderedAt: "2026-01-05T12:00:00Z",
            merchant,
            currency: "USD",
            printedGrandTotal: 87,
            lines: [
              {
                title: `${existingName} purchase line`,
                amount: 87,
                lineKind: "principal",
                quantity: 1,
              },
            ],
            payments: [{ amount: 87 }],
            allShipmentsDelivered: false,
          },
        },
      },
    ],
  });
  const expense = await db.query.expense.findFirst({
    where: eq(schema.expense.name, `${existingName} purchase line`),
  });
  if (!expense?.purchaseId)
    throw new Error("Accepted unlinked Expense missing");
  const association = await db.query.importSourceOrder.findFirst({
    where: eq(schema.importSourceOrder.purchaseId, expense.purchaseId),
  });
  if (!association?.acceptedObservationId)
    throw new Error("Accepted source snapshot missing");
  const seed = await seedPhotoGroupReviewRun(
    page,
    name,
    e2eRuntime.objectStorageUrl,
  );
  const groups = [
    {
      ...seed.groups[0]!,
      product: { kind: "existing" as const, existingId: stock.products[0]!.id },
      inventory: {
        locationId: stock.location.id,
        quantity: 1,
        ownershipMode: "inherit" as const,
      },
    },
    seed.groups[1]!,
  ];
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#work`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  await configureVariantDecisions(e2eRuntime.harness, [
    {
      feature: "product-variant-relation",
      match: existingName,
      label: "color same; size same",
    },
  ]);
  const saved = await startOperation(page.request, "photoImport.saveGroups", {
    runId: seed.runId,
    groups,
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page
    .locator("#photo-group-g1")
    .getByText("Compare existing Products", { exact: true })
    .click();
  await page
    .locator("#photo-group-g1")
    .getByRole("button", { name: "Check existing Products", exact: true })
    .click();
  const comparison = page
    .locator("#photo-group-g1")
    .locator("[data-record-list]");
  await expect(comparison.getByText(existingName).first()).toBeVisible();
  await expect(comparison.getByText(/Titles agree/).first()).toBeVisible();
  await comparison
    .getByText("Evidence and history", { exact: true })
    .first()
    .click();
  await expect(
    comparison.getByText(/Recorded count:.*Expected:/).first(),
  ).toBeVisible();
  const entryPicker = page
    .locator("#photo-group-g1")
    .getByRole("combobox", { name: "existing stock entry" });
  await entryPicker.click();
  await page
    .getByRole("option")
    .filter({ hasText: existingName })
    .first()
    .click();
  await expect(page.getByText(/Add 1 to 2 at/)).toBeVisible();
  for (const width of [402, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page
    .locator("#photo-group-g1")
    .getByRole("button", {
      name: /^(Create Product|Attach photos|Apply changes)$/,
    })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "Section index" })
      .getByRole("link", { name: /^Applied ·/ }),
  ).toBeVisible();
  const review = await page.request.get(
    `/api/v1/photoImport/review?runId=${seed.runId}`,
  );
  const body = await review.json();
  expect(
    body.review.proposals.find(
      (group: { groupKey: string }) => group.groupKey === "g1",
    )?.committedInventoryId,
  ).toBeTruthy();
  await page
    .getByRole("heading", { name: `Approved · ${existingName}` })
    .click();
  const linkSection = page.getByRole("region", {
    name: "Unlinked purchase lines",
  });
  await expect(
    linkSection.getByText(`${existingName} purchase line`),
  ).toBeVisible();
  await expect(
    linkSection.getByText(/expected quantity remains uncertain/),
  ).toBeVisible();
  const preserved = async () => ({
    inventory: await db.select().from(schema.inventoryEntry),
    payments: await db.select().from(schema.purchasePaymentEvidence),
    allocations: await db.select().from(schema.financialTransactionAllocation),
    attributions: await db.select().from(schema.expenseAttribution),
  });
  const beforeLink = await preserved();
  const reviewed = await prepareSourceOrderReconciliation(
    context.db,
    {
      sourceOrderId: association.id,
      resolution: {
        kind: "attach_only",
        lines: [
          {
            lineIndex: 0,
            expenseId: parseShortcodeFor("expense", expense.shortcode),
            productId: parseShortcodeFor("product", stock.products[0]!.id),
          },
        ],
      },
    },
    context.actor,
  );
  expect(await preserved()).toEqual(beforeLink);
  await linkSection.getByRole("button", { name: "Review this link" }).click();
  const linkReview = linkSection.getByLabel("Reviewed Expense association");
  await expect(linkReview).toContainText("$87.00");
  await linkReview
    .getByRole("button", { name: "Confirm reviewed link" })
    .click();
  await expect(
    linkSection.getByText(`${existingName} purchase line`),
  ).toHaveCount(0);
  const linked = await db.query.expense.findFirst({
    where: eq(schema.expense.id, expense.id),
  });
  expect(linked).toMatchObject({
    id: expense.id,
    cost: expense.cost,
    productQuantity: 1,
  });
  expect(linked?.productId).not.toBeNull();
  expect(await preserved()).toEqual(beforeLink);
  expect(
    await commitAcceptedSourceOrderReconciliation(
      context.db,
      {
        sourceOrderId: association.id,
        resolution: reviewed.resolution,
      },
      context.actor,
    ),
  ).toMatchObject({ alreadyApplied: true });
  expect(await preserved()).toEqual(beforeLink);
});

test("distinguishes blocking description failure from optional cutout failure", async ({
  page,
  e2eRuntime,
}) => {
  const name = `Photo processing ${Date.now()}`;
  const seed = await seedPhotoGroupReviewRun(
    page,
    name,
    e2eRuntime.objectStorageUrl,
  );
  await seedPhotoReviewProcessingFailure(
    seed.itemImage.shortcode,
    "describe_image",
    "Synthetic description failure",
  );
  await seedPhotoReviewProcessingFailure(
    seed.soloImage.shortcode,
    "subject_lift",
    "Synthetic cutout failure",
  );
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#work`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const saved = await startOperation(page.request, "photoImport.saveGroups", {
    runId: seed.runId,
    groups: seed.groups,
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await expect(
    page.getByText(/Description failed: Synthetic description failure/),
  ).toBeVisible();
  await expect(
    page.locator("#photo-group-g1").getByRole("button", {
      name: /^(Create Product|Attach photos|Apply changes)$/,
    }),
  ).toBeDisabled();
  await expect(
    page
      .locator("#photo-group-g1")
      .getByRole("link", { name: "Open photo to retry" }),
  ).toHaveAttribute("href", new RegExp(seed.itemImage.shortcode));
  await page
    .getByRole("navigation", { name: "Section index" })
    .getByRole("link", { name: new RegExp(`${name} solo find`) })
    .click();
  await expect(
    page.getByText(/Optional cutout failed: Synthetic cutout failure/),
  ).toBeVisible();
  await expect(
    page.locator("#photo-group-g2").getByRole("button", {
      name: /^(Create Product|Attach photos|Apply changes)$/,
    }),
  ).toBeEnabled();
});

test("shows an exact label identifier and a conflicting numeric boot size", async ({
  page,
  e2eRuntime,
}) => {
  const name = `Boot label ${Date.now()}`;
  const wrongSize = await seedProductPrerequisite(page, {
    name: "ForgeWear work boots tan size 9",
    manufacturer: "ForgeWear",
    externalIds: [
      {
        source: "synthetic-vendor",
        kind: "retailer_sku",
        externalId: "FW-7744",
      },
    ],
  });
  await seedProductPrerequisite(page, {
    name: "ForgeWear work boots tan size 7",
    manufacturer: "ForgeWear",
  });
  const seed = await seedPhotoGroupReviewRun(
    page,
    name,
    e2eRuntime.objectStorageUrl,
  );
  await seedPhotoReviewLabelText(
    seed.labelImage.shortcode,
    "SKU FW-7744 · US 7",
  );
  const groups = [
    { ...seed.groups[0]!, skip: [] },
    {
      ...seed.groups[1]!,
      review: {
        observedName: "ForgeWear work boots tan size 7",
        unresolvedReason: null,
        stockIntent: "evidence" as const,
      },
      images: [
        { id: seed.soloImage.shortcode, purpose: "item" as const },
        { id: seed.labelImage.shortcode, purpose: "label" as const },
      ],
      product: {
        kind: "create" as const,
        create: {
          name: "ForgeWear work boots tan size 7",
          manufacturer: "ForgeWear",
        },
      },
    },
  ];
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#work`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  await configureVariantDecisions(e2eRuntime.harness, [
    {
      feature: "product-variant-relation",
      match: "ForgeWear work boots tan size 9",
      label: "color same; size different",
    },
  ]);
  const saved = await startOperation(page.request, "photoImport.saveGroups", {
    runId: seed.runId,
    groups,
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page
    .getByRole("navigation", { name: "Section index" })
    .getByRole("link", { name: /ForgeWear work boots tan size 7/ })
    .click();
  const bootGroup = page.locator("#photo-group-g2");
  await bootGroup
    .getByText("Photo descriptions and label text", { exact: true })
    .click();
  await expect(bootGroup.getByText(/OCR: SKU FW-7744/)).toBeVisible();
  await bootGroup
    .getByText("Compare existing Products", { exact: true })
    .click();
  await bootGroup
    .getByRole("button", { name: "Check existing Products", exact: true })
    .click();
  const comparison = bootGroup.locator("[data-record-list]");
  const exactIdentifier = comparison.getByText("Exact identifier");
  await exactIdentifier.scrollIntoViewIfNeeded();
  await expect(exactIdentifier).toBeVisible();
  const wrongRow = comparison
    .locator(".ledger-row")
    .filter({ hasText: "ForgeWear work boots tan size 9" });
  const conflict = wrongRow.getByText(/Titles conflict/);
  await expect(conflict).toBeVisible();
  await wrongRow.getByText("Original comparison text", { exact: true }).click();
  await expect(wrongRow.getByText(/Photo:.*size 7/)).toBeVisible();
  await expect(wrongRow.getByText(/Product:.*size 9/)).toBeVisible();
  await expect(conflict).toContainText("check evidence");
  await expect(
    wrongRow.getByRole("button", { name: "Choose Product" }),
  ).toBeVisible();
  expect(wrongSize.id).toBeTruthy();
});

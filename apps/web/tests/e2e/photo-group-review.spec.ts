import type { Page } from "@playwright/test";
import { publishProductPair } from "~/server/domains/product/repo/match/product-match-candidate";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { startOperation } from "./support/start-operation";
import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import {
  dispatchOperations,
  operationResult,
  performOperation,
  unbatchFor,
} from "./support/dispatch-wire";
import { reviewPhotoGroupsOutput } from "@cubby/schemas/photo-import-run";
import { z } from "zod";
import type { Fixture as TestGatewayFixture } from "./harness-services/purchase-import-test-gateway";
import {
  seedProductPrerequisite,
  seedInventoryPrerequisites,
} from "./fixtures/catalog";
import { eq } from "drizzle-orm";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { TestHarness } from "wrangler";
import { getDb } from "~/server/db/helpers";
import { loadRejectedPhotoProductCandidates } from "~/server/domains/photo-import/repo/photo-group-candidates";
import { listPhotoGroupProposals } from "~/server/domains/photo-import/repo/run/proposals";
import * as schema from "~/server/db/schema";
import {
  createEvidenceHarnessContext,
  createEntityFixture,
  createFixtureGraph,
} from "./fixtures/core";
import {
  seedPhotoGroupReviewRun,
  seedPhotoReviewLabelText,
  seedImagePrerequisite,
  attachProductImagePrerequisite,
} from "./fixtures/photos";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, recordingVideo, test } from "./support/e2e-test";

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
// the reviewer did not select. Resolve identity before approving the notes-only
// historical update; the native owner retains failed-save recovery.
test("applies selected notes to a resolved historical Product without changing its name or stock", async ({
  page,
  e2eRuntime,
}) => {
  // Includes upload seeding, lazy hydration, and several persisted edits.
  test.setTimeout(Math.max(test.info().timeout, 60_000));
  const name = `Synthetic review ${Date.now()}`;
  const seed = await seedPhotoGroupReviewRun(
    page,
    name,
    e2eRuntime.objectStorageUrl,
  );
  const { existing, historicalStock } = await createFixtureGraph(
    page,
    async (create) => {
      const existing = await create("product", {
        name: `${name} shirt`,
        notes: "Original catalog notes",
      });
      const historicalStock = await create("inventory", {
        productId: existing.id,
        locationId: seed.location.id,
        amount: { value: 2, unit: "kg" },
      });
      return { existing, historicalStock };
    },
  );
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
  const group = page.locator("#photo-group-g1");
  await expect(
    group.getByRole("button", {
      name: /^(Update product and |Attach photos and |Apply and attach )/,
    }),
  ).toBeDisabled();
  await group.getByRole("button", { name: "Resolved", exact: true }).click();
  await group.getByRole("combobox", { name: "stock decision" }).click();
  await page
    .getByRole("option", {
      name: "Historical or sold · no stock change",
      exact: true,
    })
    .click();
  await group
    .getByRole("button", { name: "Choose a different Product", exact: true })
    .click();
  const changeNotes = group.getByRole("checkbox", {
    name: "Change notes",
    exact: true,
  });
  await changeNotes.click();
  await expect(changeNotes).toBeChecked();
  await group
    .getByRole("textbox", { name: "New notes", exact: true })
    .fill("Label confirmed: medium");
  await group.getByRole("textbox", { name: "New notes", exact: true }).blur();
  await group
    .getByRole("button", { name: "Apply and attach 1 photo", exact: true })
    .click();
  await page.locator("#photo-item-g1").click();
  await group
    .getByRole("heading", { name: `Approved · ${name} shirt`, exact: true })
    .click();
  await expect(
    group.getByText("Historical or sold · no stock change", { exact: true }),
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
  if (!product) throw new Error("Reviewed Product missing after approval");
  const stock = await db.query.inventoryEntry.findMany({
    where: eq(schema.inventoryEntry.productId, product.id),
  });
  expect(stock).toHaveLength(1);
  expect(stock[0]).toMatchObject({
    shortcode: historicalStock.id,
    amountValue: 2,
    amountUnit: "kg",
  });
});

test("fills the owned-items destination once and applies ready items without selection", async ({
  page,
  e2eRuntime,
}, testInfo) => {
  const batchName = `Owned batch ${Date.now()}`;
  const seed = await seedPhotoGroupReviewRun(
    page,
    batchName,
    e2eRuntime.objectStorageUrl,
  );
  const configured = await startOperation(
    page.request,
    "photoImport.setDefaults",
    {
      runId: seed.runId,
      defaults: { stockIntent: "receive", locationId: null },
    },
  );
  expect(configured.ok(), await configured.text()).toBeTruthy();
  const owned = {
    ...seed.groups[0]!,
    images: [
      ...seed.groups[0]!.images,
      { id: seed.labelImage.shortcode, purpose: "label" as const },
    ],
    skip: [],
    inventory: undefined,
    review: undefined,
  };
  const proposed = await startOperation(
    page.request,
    "photoImport.saveGroups",
    { runId: seed.runId, groups: [owned, seed.groups[1]!] },
  );
  expect(proposed.ok(), await proposed.text()).toBeTruthy();
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#photo-batch`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const group = page.locator("#photo-group-g1");
  await expect(
    group.getByRole("button", { name: /^Create product and / }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Default storage location", exact: true })
    .click();
  await page
    .getByRole("option", { name: new RegExp(`${batchName} location`) })
    .click();
  await expect(
    page.getByRole("button", { name: "Approve 2 ready items", exact: true }),
  ).toBeEnabled();
  await expect(
    group.getByRole("textbox", { name: "New product name" }),
  ).toBeVisible();
  await expect(
    group.getByRole("combobox", { name: "stock decision" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("owned-ready-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await group.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("owned-ready-mobile.png"),
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  if (recordingVideo) await page.waitForTimeout(1_000);
  const approval = page.waitForResponse((response) =>
    dispatchOperations(response.request()).some(
      (operation) => operation.operation === "photoImport.approveGroups",
    ),
  );
  await page
    .getByRole("button", { name: "Approve 2 ready items", exact: true })
    .click();
  const outcome = await operationResult(
    await approval,
    "photoImport.approveGroups",
    reviewPhotoGroupsOutput,
  );
  expect(outcome.results.map((result) => result.outcome)).toEqual([
    "committed",
    "committed",
  ]);
  await expect(
    page.getByText("0 to review · 2 settled · 0 photos not in a group", {
      exact: true,
    }),
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

  const proposed = await startOperation(
    page.request,
    "photoImport.saveGroups",
    {
      runId: seed.runId,
      groups: seed.groups,
    },
  );
  expect(proposed.ok(), await proposed.text()).toBeTruthy();
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#work`,
    page.getByRole("heading", { name: "Photo review" }),
  );

  // Batch selection stays available in the item list while one editor is open;
  // approval still checks every selected revision.
  await expect(
    page.getByRole("heading", { name: /Gray crew t-shirt/ }),
  ).toBeVisible();
  await expect(page.locator("#photo-item-g2")).toBeVisible();
  await page.getByRole("button", { name: "Select all ready items" }).click();
  await expect(
    page.getByRole("checkbox", { name: /Select Gray crew t-shirt/ }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: /Select .* solo find/ }),
  ).toBeChecked();
  const approval = page.waitForResponse((response) =>
    dispatchOperations(response.request()).some(
      (operation) => operation.operation === "photoImport.approveGroups",
    ),
  );
  await page.getByRole("button", { name: "Approve 2 selected items" }).click();
  const outcome = await operationResult(
    await approval,
    "photoImport.approveGroups",
    reviewPhotoGroupsOutput,
  );
  expect(outcome.results.map((result) => result.outcome)).toEqual([
    "committed",
    "committed",
  ]);

  await expect(
    page.getByText("0 to review · 2 settled · 0 photos not in a group", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Items to review" })
      .getByRole("button", { name: /Applied/ }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "All items · 2", exact: true })
    .click();
  await expect(
    page
      .getByLabel("Products from this import")
      .getByText("Created by this import", { exact: true }),
  ).toHaveCount(2);
});

// Moved from the retired native journey (qa-photo-selected-approval.ad): selecting only the
// second of two ready groups commits that group alone; the first stays proposed.
test("approves only the selected ready group and leaves the other proposed", async ({
  page,
  e2eRuntime,
}) => {
  const seed = await seedPhotoGroupReviewRun(
    page,
    `Selected one ${Date.now()}`,
    e2eRuntime.objectStorageUrl,
  );
  const proposed = await startOperation(
    page.request,
    "photoImport.saveGroups",
    { runId: seed.runId, groups: seed.groups },
  );
  expect(proposed.ok(), await proposed.text()).toBeTruthy();
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#photo-batch`,
    page.getByRole("heading", { name: "Photo review", exact: true }),
  );

  await page.getByRole("checkbox", { name: /Select .* solo find/ }).check();
  await expect(
    page.getByRole("checkbox", { name: /Select Gray crew t-shirt/ }),
  ).not.toBeChecked();
  const approval = page.waitForResponse((response) =>
    dispatchOperations(response.request()).some(
      (operation) => operation.operation === "photoImport.approveGroups",
    ),
  );
  await page
    .getByRole("button", { name: "Approve 1 selected item", exact: true })
    .click();
  const outcome = await operationResult(
    await approval,
    "photoImport.approveGroups",
    reviewPhotoGroupsOutput,
  );
  expect(
    outcome.results.map((result) => [result.groupKey, result.outcome]),
  ).toEqual([["g2", "committed"]]);
  expect(
    outcome.proposals
      .map((proposal) => [proposal.groupKey, proposal.state])
      .sort(),
  ).toEqual([
    ["g1", "proposed"],
    ["g2", "committed"],
  ]);
  await expect(
    page.getByText("1 to review · 1 settled · 0 photos not in a group", {
      exact: true,
    }),
  ).toBeVisible();
});

test("reviews, approves, and discards proposed photo groups on the photo-inventory run page", async ({
  page,
  e2eRuntime,
}) => {
  // Includes upload seeding, lazy hydration, and several persisted edits.
  test.setTimeout(Math.max(test.info().timeout, 60_000));
  const name = `Photo run ${Date.now()}`;
  const seed = await seedPhotoGroupReviewRun(
    page,
    name,
    e2eRuntime.objectStorageUrl,
  );
  const g2Name = `${name} solo find`;
  const { db } = await createEvidenceHarnessContext(page);
  const proposed = await startOperation(
    page.request,
    "photoImport.saveGroups",
    {
      runId: seed.runId,
      groups: seed.groups,
    },
  );
  expect(proposed.ok(), await proposed.text()).toBeTruthy();
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#work`,
    page.getByRole("heading", { name: "Photo review", exact: true }),
  );

  // Both proposed groups appear in the item list, with one editor visible.
  await expect(
    page.getByText("2 to review · 0 settled · 0 photos not in a group", {
      exact: true,
    }),
  ).toBeVisible();
  const g1Card = page.locator("[data-photo-group]").filter({
    has: page.getByRole("heading", { name: `Gray crew t-shirt — M ${name}` }),
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
      .getByRole("navigation", { name: "Items to review" })
      .getByRole("button", { name: new RegExp(g2Name) }),
  ).toBeVisible();
  if (recordingVideo) await page.waitForTimeout(1_500);

  // The Photos table lists every seeded image.
  const photosCard = page.getByRole("region", { name: "Run photos" });
  await photosCard.getByRole("button", { name: "Photos", exact: true }).click();
  await expect(
    photosCard.getByRole("link", { name: /^Open photo / }),
  ).toHaveCount(3);

  // Blurring the edited name and clicking Approve in the same gesture must
  // save the correction before creating the Product.
  const correctedName = `${name} Gray crew t-shirt — size M`;
  await g1Card
    .getByRole("textbox", { name: "New product name" })
    .fill(correctedName);
  await g1Card
    .getByRole("button", {
      name: /^(Create product and |Update product and |Attach photos and |Apply and attach )/,
    })
    .click();
  await page.locator("#photo-item-g1").click();
  const applied = page.getByRole("heading", {
    name: `Approved · ${correctedName}`,
  });
  await expect(applied).toBeVisible({ timeout: 10_000 });
  await applied.click();
  await expect(
    page
      .locator("#photo-group-g1")
      .getByRole("link", { name: correctedName, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Items to review" })
      .locator("#photo-item-g1"),
  ).toContainText("Applied");
  if (recordingVideo) await page.waitForTimeout(1_500);

  // Discard G2: nothing is left pending and the run completes.
  await page
    .getByRole("navigation", { name: "Items to review" })
    .getByRole("button", { name: new RegExp(g2Name) })
    .click();
  const g2Card = page
    .locator("[data-photo-group]")
    .filter({ has: page.getByRole("heading", { name: g2Name }) });
  await g2Card.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Items to review" })
      .locator("#photo-item-g1"),
  ).toContainText("Applied");
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
  const savedProduct = await getDb(db).query.product.findFirst({
    where: eq(schema.product.name, correctedName),
  });
  expect(savedProduct).toBeDefined();
  expect(
    await getDb(db).query.inventoryEntry.findMany({
      where: eq(schema.inventoryEntry.productId, savedProduct!.id),
    }),
  ).toMatchObject([{ amountValue: 2, amountUnit: "each" }]);
  expect(
    await getDb(db).query.product.findMany({
      where: eq(schema.product.name, g2Name),
    }),
  ).toEqual([]);
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
  seed.groups[0]!.review!.observedName = createdName;

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
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#work`,
    page.getByRole("heading", { name: "Photo review" }),
  );

  const group = page.locator("[data-photo-group]").filter({
    has: page.getByRole("heading", { name: createdName }),
  });
  // Weak neighbours offer the list without naming one; strong ones say "Compare".
  await group
    .getByRole("button", { name: /^Compare(?: existing Products)?$/ })
    .click();
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
      name: /^(Create product and |Update product and |Attach photos and |Apply and attach )/,
    })
    .click();
  await page.locator("#photo-item-g1").click();
  // The run's connections panel links the created Product too.
  await expect(
    page.getByRole("heading", { name: `Approved · ${createdName}` }),
  ).toBeVisible();
  let createdId: string | undefined;
  await expect
    .poll(async () => {
      const review = await page.request.post(
        "/api/operations/photoImport.review",
        {
          headers: { Origin: new URL(page.url()).origin },
          data: {
            operation: "photoImport.review",
            input: { runId: seed.runId },
          },
        },
      );
      if (!review.ok()) throw new Error(await review.text());
      const body = (await review.json()).data;
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
  const appliedGroup = page.locator("#photo-group-g1");
  await appliedGroup
    .getByText("Review possible matches", { exact: true })
    .click();
  await appliedGroup
    .getByRole("button", { name: /^Compare(?: existing Products)?$/ })
    .click();
  await page.locator(`a[href*="candidate=${existing.id}"]`).click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/suggestions" &&
      url.searchParams.get("family") === "product_pair" &&
      url.searchParams.get("record") === `product:${createdId}`,
  );
  // Title similarity alone stays informational. Seed the separately published
  // actionable proposal whose merge preview this journey exercises.
  await expect(
    page.getByText(
      "No pending suggestions here. Find suggestions to look again.",
    ),
  ).toBeVisible();
  const { db } = await createEvidenceHarnessContext(page);
  await publishProductPair(db, {
    productIds: [
      await resolveOrThrow(db, "product", existing.id),
      await resolveOrThrow(db, "product", createdId!),
    ],
    source: "agent",
    evidence,
    sourceUrls: ["https://retailer.example/crew-shirt"],
    actionable: true,
  });
  await page.reload();
  await expect(page.getByText(candidateName).first()).toBeVisible();
  await page
    .getByRole("button", { name: "Show evidence", exact: true })
    .click();
  await expect(
    page.getByRole("paragraph").filter({ hasText: evidence }),
  ).toBeVisible();
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

test("reviews an occupied location and adds the photo count to its chosen stock entry", async ({
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
  const productId = await resolveOrThrow(
    context.db,
    "product",
    stock.products[0]!.id,
  );
  const stockRows = () =>
    db.query.inventoryEntry.findMany({
      where: eq(schema.inventoryEntry.productId, productId),
    });
  const before = await stockRows();
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ amountValue: 2, amountUnit: "each" });
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
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#work`,
    page.getByRole("heading", { name: "Photo review" }),
  );
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
  await page
    .locator("#photo-group-g1")
    .getByRole("button", {
      name: /^(Create product and |Update product and |Attach photos and |Apply and attach )/,
    })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "Items to review" })
      .locator("#photo-item-g1"),
  ).toContainText("Applied");
  const updated = await stockRows();
  expect(updated).toHaveLength(1);
  expect(updated[0]).toMatchObject({
    id: before[0]?.id,
    locationId: before[0]?.locationId,
    amountValue: 3,
    amountUnit: "each",
  });
});

// Concern resolution must be explicit: editing the draft cannot silently unblock
// apply or batch selection. Ready drafts need no separate confirmation gate.
test("uses decision steps and preserves agent concerns until explicitly resolved", async ({
  page,
  e2eRuntime,
}) => {
  const seed = await seedPhotoGroupReviewRun(
    page,
    `Synthetic decisions ${Date.now()}`,
    e2eRuntime.objectStorageUrl,
  );
  const saved = await startOperation(page.request, "photoImport.saveGroups", {
    runId: seed.runId,
    groups: [
      {
        ...seed.groups[0]!,
        review: {
          observedName: "Synthetic jacket",
          unresolvedReason: "Check the sleeve label",
          stockIntent: "evidence",
        },
        inventory: undefined,
      },
      seed.groups[1]!,
    ],
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#photo-group-g1`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const group = page.locator("#photo-group-g1");
  await expect(group.getByText("＋ New", { exact: true })).toBeVisible();
  await expect(
    group.getByRole("button", { name: "Confirm identity", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#photo-select-g1")).toBeDisabled();
  await expect(
    group.getByRole("button", { name: /^Create product and / }),
  ).toBeDisabled();
  await expect(
    group.getByText("Agent's concern: Check the sleeve label", { exact: true }),
  ).toBeVisible();
  const name = group.getByRole("textbox", {
    name: "New product name",
    exact: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await group.scrollIntoViewIfNeeded();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await name.fill("Synthetic jacket blue XL");
  await name.blur();
  await expect(
    group.getByText("Agent's concern: Check the sleeve label", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Select all ready items", exact: true })
    .click();
  await expect(page.locator("#photo-select-g1")).not.toBeChecked();
  await page
    .getByRole("button", { name: "Approve 1 selected item", exact: true })
    .click();
  await page.locator("#photo-item-g2").click();
  await expect(
    page
      .locator("#photo-group-g2")
      .getByRole("heading", { name: /Approved ·/ }),
  ).toBeVisible();
  await page.locator("#photo-item-g1").click();
  await expect(
    group.getByRole("button", { name: /^Create product and / }),
  ).toBeDisabled();
  await group.getByRole("button", { name: "Resolved", exact: true }).click();
  await expect(page.locator("#photo-select-g1")).toBeEnabled();
  await group.getByRole("button", { name: /^Create product and / }).click();
  await page.locator("#photo-item-g1").click();
  await expect(
    group.getByRole("heading", { name: /Approved · Synthetic jacket blue XL/ }),
  ).toBeVisible();
});

// Empty evidence must not create comparison rows; create hints must stay beside
// their inputs, and the selected match must not repeat as a duplicate suggestion.
// Wrong selections must stop being suggested, including after a new group key
// inherits those photos. The create draft still exposes literal label gaps.
async function seedEvidenceReview(
  page: Page,
  objectStorageUrl: string,
  evidence = false,
) {
  const productName = `Synthetic shell jacket blue XL ${Date.now()}`;
  const brandName = `Synthetic Outfitters ${Date.now()}`;
  const brand = await createEntityFixture(page, "vendor", {
    name: brandName,
  });
  const existing = await seedProductPrerequisite(page, {
    name: productName,
    brandId: parseShortcodeFor("vendor", brand.id),
    model: "SJ-104",
    externalIds: evidence
      ? [{ source: "amazon", kind: "asin", externalId: "B0SYNTH123" }]
      : [],
  });
  const runName = `Synthetic evidence ${Date.now()}`;
  const seed = await seedPhotoGroupReviewRun(page, runName, objectStorageUrl);
  await seedPhotoReviewLabelText(
    seed.soloImage.shortcode,
    "Synthetic shell jacket blue XL",
  );
  if (evidence) {
    const cover = await seedImagePrerequisite(
      "Synthetic jacket cover",
      objectStorageUrl,
    );
    await attachProductImagePrerequisite(page, cover.id, existing.id, "item");
    const vendor = await createEntityFixture(page, "vendor", {
      name: `Example Outfitters ${Date.now()}`,
      website: "https://example.test",
    });
    const purchase = await createEntityFixture(page, "purchase", {
      vendorId: vendor.id,
      orderId: "Synthetic jacket order",
      date: "2026-03-04",
      defaultTrade: "other",
    });
    await createEntityFixture(page, "expense", {
      name: "Synthetic jacket purchase",
      purchaseId: purchase.id,
      trade: "other",
      costType: "materials",
      cost: 49,
      date: "2026-03-04",
      productId: existing.id,
      productQuantity: 1,
    });
    await createEntityFixture(page, "inventory", {
      productId: existing.id,
      locationId: seed.location.id,
      amount: { value: 1, unit: "ea" },
    });
  }
  const groups = [
    {
      ...seed.groups[0]!,
      product: { kind: "existing" as const, existingId: existing.id },
      review: {
        observedName: "Synthetic shell jacket blue XL",
        unresolvedReason: null,
        stockIntent: "evidence" as const,
      },
      inventory: undefined,
    },
    {
      ...seed.groups[1]!,
      inventory: undefined,
      review: {
        observedName: "Synthetic shell jacket",
        unresolvedReason: null,
        stockIntent: "evidence" as const,
      },
      product: {
        kind: "create" as const,
        create: {
          name: "Synthetic shell jacket",
          brandId: parseShortcodeFor("vendor", brand.id),
        },
      },
    },
  ];
  const saved = await startOperation(page.request, "photoImport.saveGroups", {
    runId: seed.runId,
    groups,
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  return { productName, runName, seed, groups, brandName };
}

test("distinguishes attach and create and exposes saved photo evidence", async ({
  page,
  e2eRuntime,
}) => {
  const { runName, seed } = await seedEvidenceReview(
    page,
    e2eRuntime.objectStorageUrl,
    true,
  );
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#photo-group-g1`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const attach = page.locator("#photo-group-g1");
  const create = page.locator("#photo-group-g2");
  await attach
    .getByRole("button", { name: "Choose a different Product", exact: true })
    .click();
  await attach
    .getByRole("button", { name: "Photo evidence and label text", exact: true })
    .click();
  // Missing evidence is a photo-slot state, not a repeated field warning.
  await expect(attach.getByLabel("Label photo missing")).toHaveCount(0);
  await expect(
    attach.getByRole("link", { name: /B0SYNTH123/ }),
  ).toHaveAttribute("href", "https://www.amazon.com/dp/B0SYNTH123");
  await expect(
    attach.getByText("No product details changed", { exact: true }),
  ).toBeVisible();
  await expect(
    attach.getByRole("heading").getByText("↪ Attach", { exact: true }),
  ).toBeVisible();
  await expect(attach.getByText("On hand", { exact: true })).toBeVisible();
  await expect(
    attach.getByRole("link", { name: `${runName} location` }),
  ).toBeVisible();
  await expect(attach.getByText("Not counted", { exact: false })).toHaveCount(
    0,
  );
  await expect(
    attach.getByText("Closest existing:", { exact: false }),
  ).toHaveCount(0);
  await expect(
    attach
      .getByRole("region", { name: "Photo evidence", exact: true })
      .getByText("No description analysis retained."),
  ).toHaveCount(1);
  await expect(
    attach.getByText("No label text — compare the photo with the product"),
  ).toBeVisible();
  await expect(
    attach.getByRole("img", { name: "In Cubby cover" }),
  ).toBeVisible();
  await expect(attach.locator('[aria-label="Field cross-checks"]')).toHaveCount(
    0,
  );
  await expect(
    attach.getByRole("button", {
      name: "Apply and attach 1 photo",
      exact: true,
    }),
  ).toBeEnabled();
  // The cover is lazy-loaded below the record summary.
  await attach
    .getByRole("img", { name: "In Cubby cover" })
    .scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      attach
        .getByRole("img", { name: "In Cubby cover" })
        .evaluate(
          (image) =>
            image instanceof HTMLImageElement &&
            image.complete &&
            image.naturalWidth > 0,
        ),
    )
    .toBe(true);

  await page.locator("#photo-item-g2").click();
  await create.scrollIntoViewIfNeeded();
  await expect(create.getByLabel("Label photo missing")).toHaveCount(0);
  await expect(
    create.getByText("Creates Synthetic shell jacket and attaches 1 photo.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(create.getByText("＋ New", { exact: true })).toBeVisible();
  await expect(
    create.getByRole("button", { name: /^Add ‘xl’ to name$/i }),
  ).toBeVisible();
  await expect(create.locator('[aria-label="Field cross-checks"]')).toHaveCount(
    0,
  );
  await expect(create.getByText("Token check:", { exact: false })).toHaveCount(
    0,
  );
  await expect(create.locator(".decision-step-action")).toHaveCount(0);
  const nameField = create.locator("[data-photo-field]").filter({
    has: page.getByRole("textbox", {
      name: "New product name",
      exact: true,
    }),
  });
  await expect(
    nameField.getByRole("button", { name: /^Add ‘blue’ to name$/i }),
  ).toBeVisible();
  await expect(nameField.getByText(/Label:|Label differs/)).toBeVisible();

  await create.getByRole("button", { name: /^Add ‘xl’ to name$/i }).click();
  await expect(
    create.getByRole("textbox", { name: "New product name", exact: true }),
  ).toHaveValue(/^Synthetic shell jacket xl$/i);

  await page.setViewportSize({ width: 390, height: 844 });
  await create.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("keeps proposed edits separate while saved product evidence loads, fails, and recovers", async ({
  page,
  e2eRuntime,
}) => {
  const { seed, groups, brandName } = await seedEvidenceReview(
    page,
    e2eRuntime.objectStorageUrl,
  );
  await seedPhotoReviewLabelText(
    seed.itemImage.shortcode,
    `${brandName}\nSJ-104\nSynthetic shell jacket blue XL`,
  );
  const attach = page.locator("#photo-group-g1");
  // Evidence keeps the saved value; pending edits appear separately as a diff.
  const changed = await startOperation(page.request, "photoImport.saveGroups", {
    runId: seed.runId,
    groups: [
      {
        ...groups[0]!,
        review: { ...groups[0]!.review, productChanges: { model: "SJ-999" } },
      },
    ],
  });
  expect(changed.ok(), await changed.text()).toBeTruthy();
  // Pending fields must never stand in for saved evidence during loading/failure.
  const releaseCurrent = Promise.withResolvers<void>();
  const interceptCurrent: Parameters<Page["route"]>[1] = async (route) => {
    if (
      await unbatchFor(route, ["entity.detail", "photoImport.productEvidence"])
    )
      return;
    const targetsCurrent = dispatchOperations(route.request()).some(
      (operation) =>
        operation.operation === "photoImport.productEvidence" ||
        (operation.operation === "entity.detail" &&
          z.object({ entity: z.literal("product") }).safeParse(operation.input)
            .success),
    );
    if (!targetsCurrent) return route.continue();
    await releaseCurrent.promise;
    await route.fulfill({
      status: 503,
      body: "Synthetic saved product evidence unavailable",
    });
  };
  await page.route(`**${BROWSER_OPERATION_PATH}/*`, interceptCurrent);
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#photo-group-g1`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const modelRow = attach.locator('[data-cross-check="model"]');
  await attach
    .getByRole("button", { name: "Choose a different Product", exact: true })
    .click();
  try {
    await expect(modelRow).toContainText("Loading current product");
    await expect(modelRow).not.toContainText("SJ-999");
  } finally {
    releaseCurrent.resolve();
  }
  await expect(modelRow).toContainText("Current product unavailable");
  await expect(modelRow).not.toContainText("SJ-999");
  await page.unroute(`**${BROWSER_OPERATION_PATH}/*`, interceptCurrent);
  const inferred = page.waitForResponse(
    (response) =>
      response.request().postData()?.includes("photoImport.candidatesBatch") ===
      true,
  );
  await page.reload();
  await (await inferred).finished();
  await expect(
    attach.getByText("Checking existing Products…", { exact: true }),
  ).toHaveCount(0);
  await expect(modelRow).toContainText("SJ-104");
  await expect(modelRow).not.toContainText("SJ-999");
  // Pending edits must not change the saved model's match or invent a missing identifier.
  await expect(modelRow.getByText("Matches the label")).toBeAttached();
  await expect(attach.locator('[data-cross-check="identifiers"]')).toHaveCount(
    0,
  );
  await expect(attach.getByLabel("Proposed model change")).toContainText(
    "SJ-999",
  );
  await expect(
    attach.getByLabel("Proposed model change").locator("del"),
  ).toHaveText("104");
});

test("rejects a photo candidate and persists the reviewed rejection", async ({
  page,
  e2eRuntime,
}) => {
  const { productName, seed } = await seedEvidenceReview(
    page,
    e2eRuntime.objectStorageUrl,
  );
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#photo-group-g1`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const attach = page.locator("#photo-group-g1");
  await attach
    .getByRole("button", { name: "Choose a different Product", exact: true })
    .click();
  await performOperation(page, "photoImport.rejectCandidate", () =>
    attach.getByRole("button", { name: "Not this one…", exact: true }).click(),
  );
  await expect(
    attach.getByText(`${productName} · Rejected`, { exact: true }).first(),
  ).toBeVisible();
  await expect(
    attach.getByRole("button", {
      name: "Apply and attach 1 photo",
      exact: true,
    }),
  ).toHaveCount(0);
  const { db } = await createEvidenceHarnessContext(page);
  const saved = await listPhotoGroupProposals(db, seed.runId);
  const proposal = saved.proposals.find((group) => group.groupKey === "g1");
  if (!proposal) throw new Error("Rejected photo proposal missing");
  expect(
    await loadRejectedPhotoProductCandidates(db, seed.runId, proposal),
  ).toMatchObject([{ name: productName, rejected: true }]);
});

// A failed inference read is recoverable evidence, never a new apply blocker.
// Real care labels are noisy: repeated lines, provenance, materials and a style
// code. Only size, colour and identifiers may raise a mark; noise never becomes
// an "Add to name" suggestion, and the agent's working note stays collapsed.
test("keeps a noisy care label to meaningful checks and linked purchase evidence", async ({
  page,
  e2eRuntime,
}) => {
  test.setTimeout(90_000);
  const productName = "Acme Harbor Penny Loafer, Black, Size 9";
  const existing = await seedProductPrerequisite(page, {
    name: productName,
    brandName: "Acme",
  });
  const runName = `Synthetic care label ${Date.now()}`;
  const seed = await seedPhotoGroupReviewRun(
    page,
    runName,
    e2eRuntime.objectStorageUrl,
  );
  await seedPhotoReviewLabelText(
    seed.itemImage.shortcode,
    "MEN'S\n9M\nC33223\nMADE IN VIETNAM\nBather and Manmade\nMEN'S",
  );
  const vendor = await createEntityFixture(page, "vendor", {
    name: "Example Marketplace",
    website: "https://example.test",
  });
  const purchase = await createEntityFixture(page, "purchase", {
    vendorId: vendor.id,
    orderId: "Synthetic loafer order",
    date: "2023-09-16",
    defaultTrade: "other",
  });
  await createEntityFixture(page, "expense", {
    name: "Synthetic loafer purchase",
    purchaseId: purchase.id,
    trade: "other",
    costType: "materials",
    cost: 106.04,
    date: "2023-09-16",
    productId: existing.id,
    productQuantity: 1,
  });
  const agentNote =
    "Synthetic agent note: label OCR reads a style code. INVENTORY DRAFT HELD for a synthetic reason that should stay out of the way.";
  const saved = await startOperation(page.request, "photoImport.saveGroups", {
    runId: seed.runId,
    groups: [
      {
        ...seed.groups[0]!,
        product: { kind: "existing" as const, existingId: existing.id },
        evidence: agentNote,
        review: {
          observedName: productName,
          unresolvedReason: null,
          stockIntent: "evidence" as const,
        },
        inventory: undefined,
      },
    ],
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#photo-group-g1`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const card = page.locator("#photo-group-g1");
  await card
    .getByRole("button", { name: "Photo evidence and label text", exact: true })
    .click();
  await card
    .getByRole("button", { name: "Choose a different Product", exact: true })
    .click();
  const label = card
    .getByRole("region", { name: "Photo evidence", exact: true })
    .getByLabel("Label text");
  await expect(label).toContainText("C33223");
  await expect(label).toHaveText(
    /^MEN'S · 9M · C33223 · MADE IN VIETNAM · Bather and Manmade$/,
  );

  const checks = card.locator('[aria-label="Field cross-checks"]');
  await expect(checks.getByText("9M", { exact: true })).toBeVisible();
  await expect(checks.getByText("Matches the label").first()).toBeAttached();
  await expect(checks.getByText(/C33223/).first()).toBeVisible();
  await expect(
    card.getByText(/Add ‘(?:made|in|vietnam|bather|and|manmade|men's)’/i),
  ).toHaveCount(0);
  await expect(card.getByText(/label adds/)).toHaveCount(0);

  await expect(
    card.getByRole("link", { name: "Example Marketplace" }),
  ).toBeVisible();
  await expect(card.getByRole("link", { name: "$106.04" })).toBeVisible();

  await expect(card.getByText("Why the agent proposed this")).toBeVisible();
  await expect(card.getByText(agentNote)).toBeHidden();
});

test("photo approval follows filtered ready scope and explicit selection overrides it", async ({
  page,
  e2eRuntime,
}) => {
  const seed = await seedPhotoGroupReviewRun(
    page,
    `Scoped review ${Date.now()}`,
    e2eRuntime.objectStorageUrl,
  );
  const proposed = await startOperation(
    page.request,
    "photoImport.saveGroups",
    { runId: seed.runId, groups: seed.groups },
  );
  expect(proposed.ok(), await proposed.text()).toBeTruthy();
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}#photo-batch`,
    page.getByRole("heading", { name: "Photo review", exact: true }),
  );
  const search = page.getByRole("textbox", { name: "Search photo groups" });
  await search.fill("Gray crew t-shirt");
  await expect(page.locator("#photo-group-g2")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Approve 1 ready item", exact: true }),
  ).toBeEnabled();
  const firstReceipt = page.waitForResponse((response) =>
    dispatchOperations(response.request()).some(
      (operation) => operation.operation === "photoImport.approveGroups",
    ),
  );
  await page
    .getByRole("button", { name: "Approve 1 ready item", exact: true })
    .click();
  const first = await operationResult(
    await firstReceipt,
    "photoImport.approveGroups",
    reviewPhotoGroupsOutput,
  );
  expect(first.results.map((item) => item.groupKey)).toEqual(["g1"]);
  expect(first.results.map((item) => item.outcome)).toEqual(["committed"]);
  expect(first.proposals.find((item) => item.groupKey === "g2")?.state).toBe(
    "proposed",
  );
  // A resolved item stays in the review position until the member changes views.
  await expect(page.locator("#photo-group-g1")).toBeAttached();
  await search.clear();
  await page
    .getByRole("navigation", { name: "Items to review" })
    .getByRole("checkbox", { name: /solo find/ })
    .check();
  await search.fill("Gray crew t-shirt");
  await expect(page.locator("#photo-group-g2")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Approve 1 selected item", exact: true }),
  ).toBeEnabled();
  const secondReceipt = page.waitForResponse((response) =>
    dispatchOperations(response.request()).some(
      (operation) => operation.operation === "photoImport.approveGroups",
    ),
  );
  await page
    .getByRole("button", { name: "Approve 1 selected item", exact: true })
    .click();
  const second = await operationResult(
    await secondReceipt,
    "photoImport.approveGroups",
    reviewPhotoGroupsOutput,
  );
  expect(second.results.map((item) => item.groupKey)).toEqual(["g2"]);
  expect(second.results.map((item) => item.outcome)).toEqual(["committed"]);
});

import type { PgTable } from "drizzle-orm/pg-core";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { fileURLToPath } from "node:url";
import { publishProductPair } from "~/server/domains/product/repo/match/product-match-candidate";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { operationCall } from "./support/operation";
import type { Fixture as TestGatewayFixture } from "./harness-services/purchase-import-test-gateway";
import {
  seedProductPrerequisite,
  seedInventoryPrerequisites,
} from "./fixtures/catalog";
import { eq } from "drizzle-orm";
import type { TestHarness } from "wrangler";
import { getDb } from "~/server/db/helpers";
import * as schema from "~/server/db/schema";
import { createEvidenceHarnessContext } from "./fixtures/core";
import { seedPhotoGroupReviewRun } from "./fixtures/photos";
import {
  chooseOption,
  gotoAuthenticatedPage,
  uniqueName,
  waitForFormHydration,
} from "./support/e2e-helpers";
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
  const proposed = await operationCall(page.request, "photoImport.saveGroups", {
    runId: seed.runId,
    groups: seed.groups,
  });
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
    where: {
      RAW: (table: PgTable) =>
        relationalSql(table, eq(schema.product.name, correctedName)),
    },
  });
  expect(savedProduct).toBeDefined();
  expect(
    await getDb(db).query.inventoryEntry.findMany({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            eq(schema.inventoryEntry.productId, savedProduct!.id),
          ),
      },
    }),
  ).toMatchObject([{ amountValue: 2, amountUnit: "each" }]);
  expect(
    await getDb(db).query.product.findMany({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, eq(schema.product.name, g2Name)),
      },
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
  const proposed = await operationCall(page.request, "photoImport.saveGroups", {
    runId: seed.runId,
    groups: seed.groups,
  });
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
    page.getByText("No pending suggestions.", { exact: true }),
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
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, eq(schema.inventoryEntry.productId, productId)),
      },
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
  const saved = await operationCall(page.request, "photoImport.saveGroups", {
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

// Own photos create a Product without an import run: the item photo becomes
// product imagery and the label photo stays label evidence. Read the saved
// Product back and open it directly; palette search is not under test here.
test("a member creates a Product from own item and label photos without an import run", async ({
  page,
}, testInfo) => {
  const fixture = (file: string) =>
    fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url));
  const name = uniqueName(testInfo, "Photo-first crew shirt");
  await gotoAuthenticatedPage(
    page,
    `/products?create=true&searchQuery=${encodeURIComponent(name)}`,
  );
  await waitForFormHydration(page);
  const editor = page.getByRole("dialog");
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await editor
    .getByLabel("Choose image")
    .setInputFiles(fixture("synthetic-wardrobe-shirt.png"));
  await expect(
    editor.getByRole("button", { name: "Remove synthetic-wardrobe-shirt.png" }),
  ).toBeVisible();
  await expect(editor.getByText("Uploading images")).toHaveCount(0);
  await chooseOption(page, editor.getByLabel("Attach as"), "Label photo");
  await editor
    .getByLabel("Choose image")
    .setInputFiles(fixture("synthetic-wardrobe-label.png"));
  await expect(
    editor.getByRole("button", { name: "Remove synthetic-wardrobe-label.png" }),
  ).toBeVisible();
  await expect(editor.getByText("Uploading images")).toHaveCount(0);
  await editor.getByRole("button", { name: /^Create$/ }).click();
  await expect(editor).not.toBeVisible({ timeout: 15_000 });

  const { db } = await createEvidenceHarnessContext(page);
  const saved = await getDb(db).query.product.findFirst({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(table, eq(schema.product.name, name)),
    },
  });
  expect(saved).toBeDefined();
  await gotoAuthenticatedPage(page, `/products/${saved!.shortcode}`);
  await page.locator("#images").scrollIntoViewIfNeeded();
  await expect(
    page
      .locator("#images")
      .getByRole("img", { name: "synthetic-wardrobe-shirt.png" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page
      .locator("#labels")
      .getByRole("img", { name: "synthetic-wardrobe-label.png" }),
  ).toBeVisible();
});

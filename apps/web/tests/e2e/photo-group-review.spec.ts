import {
  seedPhotoGroupReviewRun,
  seedProductPrerequisite,
  seedInventoryPrerequisites,
  seedUnlinkedExpensePrerequisite,
  seedPhotoReviewProcessingFailure,
  seedPhotoReviewLabelText,
} from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const recording = process.env.CUBBY_PHOTO_REVIEW_VIDEO === "1";
test.use({ video: recording ? "on" : "off" });

test("reviews, approves, and discards proposed photo groups on the photo-inventory run page", async ({
  page,
  e2eRuntime,
  baseURL,
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
    `/runs/${seed.runId}`,
    page.getByRole("heading", { name: "Photo review" }),
  );

  await expect(
    page.getByText("Waiting for an agent to propose groups."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start grouping" }),
  ).toBeVisible();
  if (recording) await page.waitForTimeout(1_500);
  const proposed = await page.request.post("/api/v1/photoImport/saveGroups", {
    data: { runId: seed.runId, groups: seed.groups },
    // API writes require a same-origin request.
    headers: { Origin: baseURL! },
  });
  expect(proposed.ok(), await proposed.text()).toBeTruthy();

  // Both proposed groups render, and every seeded photo is assigned to one.
  await expect(
    page.getByText("2 to review · 0 settled · 0 photos not in a group", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start grouping" }),
  ).toHaveCount(0);

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
        .locator("img")
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
      .getByRole("navigation", { name: "Photo item groups" })
      .getByRole("button", { name: new RegExp(g2Name) }),
  ).toBeVisible();
  if (recording) await page.waitForTimeout(1_500);

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
  if (recording) await page.waitForTimeout(1_500);

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
  await g1Card.getByRole("button", { name: "Approve item" }).click();
  await expect(page.getByRole("link", { name: correctedName })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Photo item groups" })
      .getByText("Approved", { exact: true }),
  ).toBeVisible();
  if (recording) await page.waitForTimeout(1_500);

  // Discard G2: nothing is left pending and the run completes.
  await page
    .getByRole("navigation", { name: "Photo item groups" })
    .getByRole("button", { name: new RegExp(g2Name) })
    .click();
  const g2Card = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole("heading", { name: g2Name }) });
  await g2Card.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Photo item groups" })
      .getByText("Discarded", { exact: true }),
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
  await page
    .getByRole("button", { name: "Start new run with same inputs" })
    .click();
  await expect(page).not.toHaveURL(new RegExp(`/runs/${seed.runId}$`));
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
  if (recording) await page.waitForTimeout(1_500);
});

test("suggests an existing variant and previews every merge decision for a created photo product", async ({
  page,
  e2eRuntime,
  baseURL,
}) => {
  const name = `Photo match ${Date.now()}`;
  const candidateName = `Gray crew t-shirt M ${name}`;
  const existing = await seedProductPrerequisite(page, { name: candidateName });
  const seed = await seedPhotoGroupReviewRun(
    page,
    name,
    e2eRuntime.objectStorageUrl,
  );
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runId}`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const proposed = await page.request.post("/api/v1/photoImport/saveGroups", {
    data: { runId: seed.runId, groups: seed.groups },
    // API writes require a same-origin request.
    headers: { Origin: baseURL! },
  });
  expect(proposed.ok(), await proposed.text()).toBeTruthy();

  const group = page.locator('[data-slot="card"]').filter({
    has: page.getByRole("heading", { name: "Gray crew t-shirt — M" }),
  });
  await expect(group.getByText("Product comparison")).toBeVisible();
  await expect(group.getByText(candidateName)).toBeVisible();
  await expect(group.getByText("Gray in both sources")).toBeVisible();
  await group.getByRole("button", { name: "Approve item" }).click();
  await expect(
    page.getByRole("link", { name: "Gray crew t-shirt — M" }),
  ).toBeVisible();
  const review = await page.request.get(
    `/api/v1/photoImport/review?runId=${seed.runId}`,
  );
  const body = await review.json();
  const createdId = body.review.proposals.find(
    (item: { groupKey: string }) => item.groupKey === "g1",
  )?.committedProduct?.id;
  expect(createdId).toBeTruthy();

  await page.getByText("Review possible matches", { exact: true }).click();
  await page.locator(`a[href*="candidate=${existing.id}"]`).click();
  await expect(page).toHaveURL(/recommendations\/workbench/);
  await expect(page.getByText(candidateName).first()).toBeVisible();
  await expect(page.getByText("Variant words in Product titles")).toBeVisible();
  await page.getByRole("button", { name: "Review merge" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "What the merged product will keep" }),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) < 768) {
    const decisions = dialog.getByTestId("product-merge-mobile-decisions");
    await expect(decisions).toBeVisible();
    await expect(decisions).toContainText("Gray crew t-shirt — M");
    await expect(decisions).toContainText("Merge both");
    await expect(decisions).toContainText("1 image");
  } else {
    await expect(dialog.getByRole("row", { name: /Name/ })).toContainText(
      "Gray crew t-shirt — M",
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
  baseURL,
}) => {
  const name = `Photo decision ${Date.now()}`;
  const existingName = `Gray crew t-shirt M ${name}`;
  const stock = await seedInventoryPrerequisites(page, {
    locationName: `${name} shelf`,
    products: [{ name: existingName, quantity: 2, unit: "each" }],
  });
  const expense = await seedUnlinkedExpensePrerequisite(
    page,
    `${existingName} purchase line`,
  );
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
    `/runs/${seed.runId}`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const saved = await page.request.post("/api/v1/photoImport/saveGroups", {
    data: { runId: seed.runId, groups },
    headers: { Origin: baseURL! },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const comparison = page.getByRole("region", { name: "Product comparison" });
  await expect(comparison.getByText(existingName)).toBeVisible();
  await expect(comparison.getByText("Counted now").first()).toBeVisible();
  await expect(comparison.getByText("Ledger expected").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add to existing entry" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add to existing entry" }).click();
  await expect(page.getByText(/Add 1 to 2 already at/)).toBeVisible();
  for (const width of [402, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.getByRole("button", { name: "Approve item" }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Photo item groups" })
      .getByText("Approved", { exact: true }),
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
  const linkSection = page.getByRole("region", {
    name: "Unlinked purchase lines",
  });
  await expect(
    linkSection.getByText(`${existingName} purchase line`),
  ).toBeVisible();
  await expect(
    linkSection.getByText(/expected quantity remains uncertain/),
  ).toBeVisible();
  await linkSection.getByRole("button", { name: "Link this line" }).click();
  await expect(
    linkSection.getByText(`${existingName} purchase line`),
  ).toHaveCount(0);
  const repeated = await page.request.post("/api/v1/photoImport/linkExpense", {
    data: { runId: seed.runId, groupKey: "g1", expenseId: expense.id },
    headers: { Origin: baseURL! },
  });
  expect(repeated.ok()).toBe(false);
});

test("distinguishes blocking description failure from optional cutout failure", async ({
  page,
  e2eRuntime,
  baseURL,
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
    `/runs/${seed.runId}`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const saved = await page.request.post("/api/v1/photoImport/saveGroups", {
    data: { runId: seed.runId, groups: seed.groups },
    headers: { Origin: baseURL! },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await expect(
    page.getByText(/Description failed: Synthetic description failure/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve item" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Open photo to retry" }),
  ).toHaveAttribute("href", new RegExp(seed.itemImage.shortcode));
  await page
    .getByRole("navigation", { name: "Photo item groups" })
    .getByRole("button", { name: new RegExp(`${name} solo find`) })
    .click();
  await expect(
    page.getByText(/Optional cutout failed: Synthetic cutout failure/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve item" }),
  ).toBeEnabled();
});

test("shows an exact label identifier and a conflicting numeric boot size", async ({
  page,
  e2eRuntime,
  baseURL,
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
    `/runs/${seed.runId}`,
    page.getByRole("heading", { name: "Photo review" }),
  );
  const saved = await page.request.post("/api/v1/photoImport/saveGroups", {
    data: { runId: seed.runId, groups },
    headers: { Origin: baseURL! },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page
    .getByRole("navigation", { name: "Photo item groups" })
    .getByRole("button", { name: /ForgeWear work boots tan size 7/ })
    .click();
  await expect(page.getByText(/OCR: SKU FW-7744/)).toBeVisible();
  const comparison = page.getByRole("region", { name: "Product comparison" });
  await expect(
    comparison.getByText("Exact label identifier: FW-7744"),
  ).toBeVisible();
  const wrongRow = comparison
    .getByRole("article")
    .filter({ hasText: "ForgeWear work boots tan size 9" });
  await expect(
    wrongRow.getByText(/Proposal: US 7; Product: US 9 — check evidence/),
  ).toBeVisible();
  await expect(
    wrongRow.getByRole("button", { name: "Use product" }),
  ).toBeVisible();
  expect(wrongSize.id).toBeTruthy();
});

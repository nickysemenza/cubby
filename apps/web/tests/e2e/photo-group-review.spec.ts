import {
  seedPhotoGroupReviewRun,
  seedProductPrerequisite,
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
    page.getByRole("heading", { name: "Proposed items" }),
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

  const g2Card = page.locator('[data-slot="card"]').filter({
    has: page.getByRole("heading", { name: g2Name }),
  });
  await expect(g2Card).toBeVisible();
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
  await g1Card.getByRole("button", { name: "Approve", exact: true }).click();
  const settledCard = page.getByRole("region", { name: "Settled groups" });
  await expect(settledCard).toBeVisible();
  await expect(
    settledCard.getByRole("link", { name: correctedName }),
  ).toBeVisible();
  await expect(
    settledCard.getByText("Approved", { exact: true }),
  ).toBeVisible();
  if (recording) await page.waitForTimeout(1_500);

  // Discard G2: nothing is left pending and the run completes.
  await g2Card.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(
    settledCard.getByText("Discarded", { exact: true }),
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
    page.getByRole("heading", { name: "Proposed items" }),
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
  await expect(
    group.getByText("Could this already be a product?"),
  ).toBeVisible();
  await expect(group.getByText(candidateName)).toBeVisible();
  await expect(group.getByText("Gray in both titles")).toBeVisible();
  await group.getByRole("button", { name: "Approve", exact: true }).click();
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

  const settled = page.getByRole("region", { name: "Settled groups" });
  await settled
    .getByRole("button", { name: "Review possible matches" })
    .click();
  await settled.locator(`a[href*="candidate=${existing.id}"]`).click();
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

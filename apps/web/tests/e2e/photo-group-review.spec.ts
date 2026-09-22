import { seedPhotoGroupReviewRun } from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("reviews, approves, and discards proposed photo groups on the photo-inventory run page", async ({
  page,
}) => {
  const name = `Photo run ${Date.now()}`;
  const seed = await seedPhotoGroupReviewRun(page, name);
  const g2Name = `${name} solo find`;

  await gotoAuthenticatedPage(
    page,
    `/import-runs/${seed.runId}`,
    page.getByRole("heading", { name: "Proposed items" }),
  );

  // Both proposed groups render, and every seeded photo is assigned to one.
  await expect(
    page.getByText("2 to review · 0 settled · 0 photos not in a group", {
      exact: true,
    }),
  ).toBeVisible();

  const g1Card = page.locator('[data-slot="card"]').filter({
    has: page.getByRole("heading", { name: "Gray crew t-shirt — M" }),
  });
  await expect(g1Card).toBeVisible();
  await expect(g1Card.getByText("Item", { exact: true })).toBeVisible();
  await expect(g1Card.getByText("Label", { exact: true })).toBeVisible();

  const g2Card = page.locator('[data-slot="card"]').filter({
    has: page.getByRole("heading", { name: g2Name }),
  });
  await expect(g2Card).toBeVisible();

  // The Photos table lists every seeded image.
  const photosCard = page.locator('[data-slot="card"]').filter({
    has: page.getByRole("heading", { name: "Photos" }),
  });
  await expect(
    photosCard.getByRole("link", { name: /^Open photo / }),
  ).toHaveCount(3);

  // Approve G1: it moves into the settled table and its Product now exists.
  await g1Card.getByRole("button", { name: "Approve", exact: true }).click();
  const settledCard = page.locator('[data-slot="card"]').filter({
    has: page.getByRole("heading", { name: "Settled groups" }),
  });
  await expect(settledCard).toBeVisible();
  await expect(
    settledCard.getByRole("link", { name: "Gray crew t-shirt — M" }),
  ).toBeVisible();
  await expect(
    settledCard.getByText("Approved", { exact: true }),
  ).toBeVisible();

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
  await expect(page.getByText("completed", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
});

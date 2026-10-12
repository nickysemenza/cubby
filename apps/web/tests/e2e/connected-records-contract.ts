import type { Page } from "@playwright/test";

import {
  seedPlantPrerequisite,
  seedPlantingPrerequisite,
  seedPlantPurchasePrerequisite,
  seedProjectPrerequisite,
  seedTaskPrerequisite,
  seedVendorDisplayPrerequisite,
} from "./fixtures-catalog";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect } from "./e2e-test";

export async function plantTaskConnection(page: Page) {
  const suffix = Date.now();
  const plant = await seedPlantPrerequisite(page, `Connection crop ${suffix}`);
  const project = await seedProjectPrerequisite(
    page,
    `Connection project ${suffix}`,
  );
  const taskName = `Connection task ${suffix}`;
  const task = await seedTaskPrerequisite(page, {
    name: taskName,
    projectId: project.id,
  });
  const planting = await seedPlantingPrerequisite(page, {
    plantId: plant.id,
    taskId: task.id,
  });
  const vendor = await seedVendorDisplayPrerequisite(
    page,
    `Connection supplier ${suffix}`,
  );
  const seed = await seedPlantPurchasePrerequisite(page, {
    plantId: plant.id,
    vendorId: vendor.id,
    name: `Connection seeds ${suffix}`,
  });
  const starter = await seedPlantPurchasePrerequisite(page, {
    plantId: plant.id,
    vendorId: vendor.id,
    name: `Connection starter ${suffix}`,
  });

  await gotoAuthenticatedPage(page, `/plants/${plant.id}`);
  await page
    .getByRole("heading", { level: 2, name: "Relations", exact: true })
    .scrollIntoViewIfNeeded();
  // One grouped section reads every curated view; each row carries its hops.
  const section = page.locator("#connected-records");
  await expect(section).toBeVisible();
  const taskRow = section
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: taskName }) });
  await expect(taskRow.first()).toBeVisible();
  await expect(taskRow.first().getByText("2 hops")).toBeVisible();
  // Intermediate records read by kind and still open their record.
  await expect(
    taskRow.first().getByRole("link", { name: "Planting", exact: true }),
  ).toHaveAttribute("href", `/plantings/${planting.id}`);
  await expect(
    section.getByRole("link", { name: `Connection project ${suffix}` }).first(),
  ).toBeVisible();
  await expect(
    section.locator(`a[href="/purchases/${seed.purchase.id}"]`).first(),
  ).toBeVisible();
  await expect(
    section.locator(`a[href="/purchases/${starter.purchase.id}"]`).first(),
  ).toBeVisible();
  await expect(section.getByText(/^No connections: /u)).toBeVisible();
  await page
    .getByRole("heading", { level: 2, name: "Work", exact: true })
    .scrollIntoViewIfNeeded();

  await page.getByRole("button", { name: "Open all plantings" }).click();
  await expect(page).toHaveURL(/\/connections\?.*view=relation%3Aplantings/u);
  await expect(
    page.locator(`a[href="/plantings/${planting.id}"]`).first(),
  ).toBeVisible();

  await gotoAuthenticatedPage(page, `/products/${seed.product.id}`);
  await page
    .getByRole("heading", { level: 2, name: "Work", exact: true })
    .scrollIntoViewIfNeeded();
  const productPurchases = page.locator("#purchases");
  await expect(
    productPurchases
      .locator(`a[href="/purchases/${seed.purchase.id}"]`)
      .first(),
  ).toBeVisible();
  await expect(
    productPurchases.getByText("Connected through").last(),
  ).toBeVisible();

  await gotoAuthenticatedPage(page, `/vendors/${vendor.id}`);
  await page
    .getByRole("heading", { level: 2, name: "Work", exact: true })
    .scrollIntoViewIfNeeded();
  const purchasedProducts = page.locator("#purchased-products");
  await expect(
    purchasedProducts.locator(`a[href="/products/${seed.product.id}"]`).first(),
  ).toBeVisible();
  await expect(
    purchasedProducts.getByText("Connected through").last(),
  ).toBeVisible();

  await gotoAuthenticatedPage(page, `/projects/${project.id}`);
  await page
    .getByRole("heading", { level: 2, name: "Work", exact: true })
    .scrollIntoViewIfNeeded();
  const projectTasks = page.locator("#tasks");
  await expect(
    projectTasks.locator(`a[href="/tasks/${task.id}"]`).first(),
  ).toBeVisible();
  await expect(
    page
      .locator("#connected-records")
      .locator(`a[href="/plantings/${planting.id}"]`)
      .first(),
  ).toBeVisible();
}

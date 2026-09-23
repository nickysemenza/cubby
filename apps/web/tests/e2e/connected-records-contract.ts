import type { Page } from "@playwright/test";

import {
  seedPlantPrerequisite,
  seedPlantingPrerequisite,
  seedPlantPurchasePrerequisite,
  seedProjectPrerequisite,
  seedTaskPrerequisite,
  seedVendorDisplayPrerequisite,
} from "./e2e-fixtures";
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
  const section = page.locator("#connected-tasks");
  await expect(section).toBeVisible();
  await expect(
    section.getByRole("link", { name: taskName }).first(),
  ).toBeVisible();
  await expect(section.getByText("2 record hops")).toBeVisible();
  await expect(
    section.locator(`a[href="/plantings/${planting.id}"]`),
  ).toBeVisible();
  const projects = page.locator("#connected-projects");
  await expect(
    projects
      .getByRole("link", { name: `Connection project ${suffix}` })
      .first(),
  ).toBeVisible();
  const purchases = page.locator("#connected-purchases");
  await expect(
    purchases.locator(`a[href="/purchases/${seed.purchase.id}"]`).first(),
  ).toBeVisible();
  await expect(
    purchases.locator(`a[href="/purchases/${starter.purchase.id}"]`).first(),
  ).toBeVisible();
  await expect(purchases.getByText("2–3 record hops")).toBeVisible();
  await expect(purchases.getByText(/^3 hops/u).first()).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeInViewport();

  await page.getByRole("button", { name: "Open all plantings" }).click();
  await expect(page).toHaveURL(/\/connections\?.*view=relation%3Aplantings/u);
  await expect(
    page.locator(`a[href="/plantings/${planting.id}"]`).first(),
  ).toBeVisible();
}

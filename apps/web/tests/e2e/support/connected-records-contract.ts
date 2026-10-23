import type { Page } from "@playwright/test";

import { createFixtureGraph } from "../fixtures/core";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect } from "./e2e-test";

export async function plantTaskConnection(page: Page) {
  const suffix = Date.now();
  const taskName = `Connection task ${suffix}`;
  const { plant, project, task, planting, vendor, seed, starter } =
    await createFixtureGraph(page, async (create) => {
      const plant = await create("plant", {
        name: `Connection crop ${suffix}`,
      });
      const project = await create("project", {
        name: `Connection project ${suffix}`,
      });
      const task = await create("task", {
        name: taskName,
        trade: "other",
        projectId: project.id,
      });
      const planting = await create("planting", {
        plantId: plant.id,
        locationId: null,
        taskId: task.id,
      });
      const vendorName = `Connection supplier ${suffix}`;
      const vendor = await create("vendor", {
        name: vendorName,
        website: "https://example.com",
        orderUrlTemplate: "https://example.com/orders/{orderId}",
        notes: `${vendorName} notes`,
      });
      const brand = await create("vendor", { name: "E2E fixture" });
      const purchaseFor = async (name: string) => {
        const product = await create("product", {
          brandId: brand.id,
          name: `${name} product`,
          growsPlantId: plant.id,
        });
        const purchase = await create("purchase", {
          vendorId: vendor.id,
          orderId: `${name} order`,
          date: "2026-09-09",
        });
        await create("expense", {
          name: `${name} expense`,
          cost: 7,
          date: "2026-09-09",
          costType: "materials",
          trade: "other",
          productId: product.id,
          productQuantity: 1,
          purchaseId: purchase.id,
        });
        return { product, purchase };
      };
      const seed = await purchaseFor(`Connection seeds ${suffix}`);
      const starter = await purchaseFor(`Connection starter ${suffix}`);
      return { plant, project, task, planting, vendor, seed, starter };
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

import { expect, test } from "@playwright/test";
import { waitForFormHydration } from "./e2e-helpers";

test("assigns a Product in the matrix and shows it in the Collection locator", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}x${testInfo.retry}`;
  const collectionName = `Painting ${stamp}`;
  const slug = `painting-${stamp.toLowerCase()}`;
  const firstProduct = `${stamp} primer`;
  const matrixProduct = `${stamp} brush`;

  const createProduct = async (name: string) => {
    await page.goto("/products/new");
    await waitForFormHydration(page);
    await page.getByPlaceholder("Enter product name").fill(name);
    await page.getByPlaceholder("Enter manufacturer").fill("E2E Paint Co");
    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page).toHaveURL(
      /\/products\/PRD-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/,
      { timeout: 15_000 },
    );
    return page.url().split("/").at(-1)!;
  };

  const firstId = await createProduct(firstProduct);
  await createProduct(matrixProduct);

  await page.goto(
    `/collections/assignments?q=${encodeURIComponent(firstProduct)}`,
  );
  await page.getByRole("button", { name: "New Collection" }).click();
  await page.getByLabel("Name", { exact: true }).fill(collectionName);
  await page.getByLabel("First product").selectOption(firstId);
  await page.getByRole("button", { name: "Create Collection" }).click();
  await expect(
    page.getByRole("button", {
      name: new RegExp(
        `Remove direct ${collectionName} assignment for ${firstProduct}`,
      ),
    }),
  ).toBeVisible({ timeout: 15_000 });

  await page.goto(
    `/collections/assignments?q=${encodeURIComponent(matrixProduct)}`,
  );
  await expect(page.getByRole("link", { name: matrixProduct })).toHaveAttribute(
    "href",
    /\/products\/PRD-/,
  );
  const assignment = page.getByRole("button", {
    name: new RegExp(
      `Add direct ${collectionName} assignment for ${matrixProduct}`,
    ),
  });
  await expect(assignment).toBeVisible({ timeout: 15_000 });
  await assignment.focus();
  await expect(assignment).toBeFocused();
  await assignment.press("Space");
  await expect(
    page.getByRole("button", {
      name: new RegExp(
        `Remove direct ${collectionName} assignment for ${matrixProduct}`,
      ),
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(750);

  await page.goto(`/collections/${slug}`);
  await expect(page.getByRole("link", { name: matrixProduct })).toBeVisible({
    timeout: 15_000,
  });
});

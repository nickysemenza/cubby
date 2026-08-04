import { expect, test } from "@playwright/test";

test("Locations gallery does not paginate the complete inventory", async ({
  page,
}) => {
  const inventoryListRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc/inventory.list")) {
      inventoryListRequests.push(request.url());
    }
  });

  await page.goto("/locations", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible();
  expect(inventoryListRequests).toEqual([]);
});

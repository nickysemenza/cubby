import { readFileSync } from "node:fs";

import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Scanning, recount, sweep, and the location photo pass moved to the native
// app; their web routes are gone and answer with the ordinary not-found page.

for (const path of [
  "/scan",
  "/inventory/session",
  "/inventory/session?parent=LOC-4K7M",
  "/inventory/session?worklist=shelf-disagrees",
  "/locations/photo-pass",
  "/locations/photo-pass?parent=LOC-4K7M",
]) {
  test(`${path} is not found`, async ({ page }) => {
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(404);
  });
}

const unfinishedPass = {
  version: 4,
  startedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  currentIndex: 1,
  completed: ["LOC-4K7M"],
  skipped: [],
  totalCount: 3,
  extra: { itemResolutions: [["INV-4K7M", { kind: "remove" }]], summary: {} },
};

test("an unfinished browser-local recount is offered for download, then removed", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/settings");
  await page.evaluate((pass) => {
    localStorage.setItem("cubby:audit-session:LOC-4K7M", JSON.stringify(pass));
    localStorage.setItem("cubby:shelf-triage:all", "{}");
  }, unfinishedPass);
  await page.reload();

  const dialog = page.getByRole("alertdialog", {
    name: "Unfinished work in this browser",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Recount · LOC-4K7M/)).toBeVisible();
  await expect(dialog.getByText(/1 unsaved decisions/)).toBeVisible();

  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download and discard" }).click();
  const file = await (await download).path();
  const exported = JSON.parse(readFileSync(file, "utf8"));
  expect(exported.passes[0]).toMatchObject({
    key: "cubby:audit-session:LOC-4K7M",
    kind: "recount",
  });

  await expect(dialog).toBeHidden();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).not.toContain("cubby:audit-session:LOC-4K7M");
  // Shelf triage is still a web workflow; its state is not ours to remove.
  expect(keys).toContain("cubby:shelf-triage:all");
});

test("finished or unreadable passes are removed without a prompt", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/settings");
  await page.evaluate((pass) => {
    localStorage.setItem(
      "cubby:audit-session:LOC-4K7M",
      JSON.stringify({ ...pass, completed: ["a", "b", "c"], extra: undefined }),
    );
    localStorage.setItem("cubby:photo-pass:house|false|", "not json");
  }, unfinishedPass);
  await page.reload();

  await expect
    .poll(() => page.evaluate(() => Object.keys(localStorage)))
    .not.toContain("cubby:audit-session:LOC-4K7M");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("the old service worker URL serves a worker that unregisters itself", async ({
  request,
}) => {
  const response = await request.get("/sw.js");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/javascript/);
  expect(await response.text()).toContain("registration.unregister()");
});

test("pages no longer advertise an installable app", async ({ page }) => {
  await gotoAuthenticatedPage(page, "/settings");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(0);
});

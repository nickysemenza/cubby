import { readFileSync } from "node:fs";

import { gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { seedLocationPrerequisite } from "./fixtures-catalog";

// Scanning, recount, sweep, and the location photo pass moved to the native
// app. Their old URLs (bookmarks, notes, home-screen shortcuts) must land on a
// surviving page with a notice, never a 404.

test("old fieldwork URLs redirect to the location or list with a moved-to-app notice", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Synthetic retired fieldwork shelf");
  const location = await seedLocationPrerequisite(page, name);
  const heading = page.getByRole("heading", { level: 1, name });

  await gotoAuthenticatedPage(
    page,
    `/inventory/session?parent=${location.id}`,
    heading,
  );
  await expect(page).toHaveURL(new RegExp(`/locations/${location.id}$`));
  await expect(page.getByText(/Recounts moved to the Cubby app/)).toBeVisible();

  await gotoAuthenticatedPage(
    page,
    `/locations/photo-pass?parent=${location.id}`,
    heading,
  );
  await expect(page).toHaveURL(new RegExp(`/locations/${location.id}$`));
  await expect(
    page.getByText(/location photo pass moved to the Cubby app/),
  ).toBeVisible();

  await gotoAuthenticatedPage(
    page,
    "/inventory/session?worklist=shelf-disagrees",
  );
  await expect(page).toHaveURL(/\/inventory$/);

  await gotoAuthenticatedPage(page, "/locations/photo-pass");
  await expect(page).toHaveURL(/\/locations$/);

  await gotoAuthenticatedPage(page, "/scan");
  await expect(page).toHaveURL(/^[^#?]*\/(#.*)?$/);
  await expect(page.getByText(/Scanning moved to the Cubby app/)).toBeVisible();
});

test("the notice fragment is dropped so a reload does not repeat it", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/scan");
  await expect(page.getByText(/Scanning moved to the Cubby app/)).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
});

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

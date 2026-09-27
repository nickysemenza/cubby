import superjson from "superjson";
import type { VendorSearchMailOut } from "@cubby/schemas/order-mail-review";
import { runShortcode } from "@cubby/schemas/identifiers";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";

import {
  seedVendorDisplayPrerequisite,
  seedFailedVendorMailSearchRun,
  seedVendorMailReviewPrerequisite,
} from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("reviews a vendor email match and shows the linked conversation on Purchase", async ({
  page,
}) => {
  const seed = await seedVendorMailReviewPrerequisite(
    page,
    `Synthetic Outfitters ${Date.now()}`,
  );
  await gotoAuthenticatedPage(
    page,
    `/vendors/${seed.vendor.shortcode}`,
    page.getByText("Synthetic order receipt"),
  );
  await expect(
    page.getByRole("button", { name: "Search Gmail now" }),
  ).toBeVisible();
  const receipt = page
    .getByRole("article")
    .filter({ hasText: "Synthetic order receipt" });
  await expect(
    receipt.getByRole("link", { name: "SYN-ORDER-1001" }),
  ).toBeVisible();
  await receipt.getByRole("button", { name: "Dismiss" }).click();
  await expect(receipt.getByText("dismissed", { exact: true })).toBeVisible();
  await page.reload();
  await expect(receipt.getByText("dismissed", { exact: true })).toBeVisible();
  await receipt.getByRole("button", { name: "Link" }).click();
  await expect(receipt.getByText("linked", { exact: true })).toBeVisible();

  await gotoAuthenticatedPage(
    page,
    `/purchases/${seed.purchase.shortcode}`,
    page.getByText("Synthetic order receipt"),
  );
  await expect(page.getByText("Synthetic order receipt")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open Gmail conversation" }),
  ).toBeVisible();
});

test("queues a local synthetic Gmail search, shows progress, and continues to older mail", async ({
  page,
}) => {
  const vendor = await seedVendorDisplayPrerequisite(
    page,
    `Synthetic search vendor ${Date.now()}`,
  );
  const starts: Array<{ pageToken?: string }> = [];
  const queuedStatus: VendorSearchMailOut = {
    status: "queued",
    searched: 0,
    skipped: 0,
    reviewable: 0,
    after: "2025/09/27",
    nextPageToken: null,
    error: null,
    createdAt: new Date().toISOString(),
    runShortcode: runShortcode.parse("RUN-TEST"),
  };
  let status: VendorSearchMailOut | null = null;
  await page.route(`**${BROWSER_OPERATION_PATH}`, async (route) => {
    const operation = route.request().headers()["x-cubby-operation"];
    if (operation === "vendor.searchOrderMail") {
      const payload = superjson.deserialize<{ input: { pageToken?: string } }>(
        JSON.parse(route.request().postData() ?? "{}"),
      );
      starts.push(payload.input);
      status = {
        ...queuedStatus,
        createdAt: new Date(Date.now() + starts.length * 1000).toISOString(),
      };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(superjson.serialize({ ok: true, data: status })),
      });
      return;
    }
    if (operation === "vendor.orderMailSearchStatus") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(superjson.serialize({ ok: true, data: status })),
      });
      return;
    }
    await route.fallback();
  });
  await gotoAuthenticatedPage(
    page,
    `/vendors/${vendor.id}`,
    page.getByRole("button", { name: "Search Gmail now" }),
  );
  await page.getByRole("button", { name: "Search Gmail now" }).click();
  await expect(page.getByText(/Gmail search is running/u)).toBeVisible();
  await expect(page.getByRole("link", { name: "View run" })).toHaveAttribute(
    "href",
    "/runs/RUN-TEST",
  );
  await expect(
    page.getByText(/Matches will appear when the job finishes/u),
  ).toBeVisible();
  expect(starts).toHaveLength(1);
  status = {
    ...queuedStatus,
    status: "completed",
    searched: 10,
    skipped: 6,
    reviewable: 2,
    nextPageToken: "older-page",
    createdAt: new Date(Date.now() + starts.length * 1000).toISOString(),
  };
  await expect(
    page.getByText(/Checked 10 messages; 6 already saved/u),
  ).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Search older email" }).click();
  expect(starts[1]?.pageToken).toBe("older-page");
  status = {
    ...queuedStatus,
    status: "failed",
    error: "Gmail page retrieval failed: 429 synthetic limit",
    createdAt: new Date(Date.now() + starts.length * 1000).toISOString(),
  };
  await expect(page.getByRole("alert")).toContainText(
    "Gmail page retrieval failed: 429 synthetic limit",
    { timeout: 10_000 },
  );
  await page.getByRole("button", { name: "Search Gmail now" }).click();
  expect(starts).toHaveLength(3);
});

test("shows a failed Gmail search's saved reason on its Run page", async ({
  page,
}) => {
  const seed = await seedFailedVendorMailSearchRun(
    page,
    `Synthetic failed search ${Date.now()}`,
  );
  await gotoAuthenticatedPage(
    page,
    `/vendors/${seed.vendor.shortcode}`,
    page.getByRole("link", { name: "View run" }),
  );
  await page.getByRole("link", { name: "View run" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${seed.runShortcode}$`, "u"));
  await expect(page.getByText("Failure details")).toBeVisible();
  await expect(page.getByText("Synthetic review count failure")).toBeVisible();
});

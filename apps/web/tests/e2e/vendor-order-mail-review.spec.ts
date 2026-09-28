import superjson from "superjson";
import type { VendorSearchMailOut } from "@cubby/schemas/order-mail-review";
import { runShortcode } from "@cubby/schemas/identifiers";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";

import {
  seedVendorDisplayPrerequisite,
  seedFailedVendorMailSearchRun,
  seedLiveVendorMailSearchRun,
  seedPagedVendorMailSearchRun,
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
  const starts: Array<{ pageToken?: string; after?: string }> = [];
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
      const payload = superjson.deserialize<{
        input: { pageToken?: string; after?: string };
      }>(JSON.parse(route.request().postData() ?? "{}"));
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
  await expect(
    page.getByText(/Waiting for the background worker/u),
  ).toBeVisible();
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
  await page
    .getByRole("button", { name: "Continue unfinished search" })
    .click();
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
  status = {
    ...queuedStatus,
    status: "completed",
    createdAt: new Date(Date.now() + 4_000).toISOString(),
  };
  await page.getByRole("button", { name: "Search all history" }).click();
  expect(starts[3]).toMatchObject({ after: "1970/01/01" });
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

test("updates a Run's progress live and retains its completed search summary", async ({
  page,
}) => {
  const seed = await seedLiveVendorMailSearchRun(
    page,
    `Synthetic live search ${Date.now()}`,
  );
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runShortcode}`,
    page.getByText("Waiting to search Gmail").last(),
  );
  await expect(
    page.getByRole("region", { name: "Search inputs" }),
  ).toContainText("example.test");
  await expect(
    page.getByRole("region", { name: "Search inputs" }),
  ).toContainText("Since");
  await seed.advance();
  await expect(page.getByText("Checked 4 of 6 messages").last()).toBeVisible();
  await expect(page.getByText("6 messages found")).toBeVisible();
  await seed.complete();
  await expect(page.getByText("Run completed")).toBeVisible();
  await expect(page.getByText("1 page scanned")).toBeVisible();
  await expect(
    page.getByText("1 order email to review", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("Run completed")).toBeVisible();
  await expect(
    page.getByText(
      "Checked 6 messages; 2 already saved; 1 order email to review",
    ),
  ).toBeVisible();
});

test("shows how long a queued Gmail Run has waited and offers retry", async ({
  page,
}) => {
  const seed = await seedLiveVendorMailSearchRun(
    page,
    `Synthetic queued search ${Date.now()}`,
  );
  await seed.ageQueue();
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runShortcode}`,
    page.getByText("Waiting for background worker"),
  );
  await expect(page.getByText(/Waiting for 4m/u)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry queue delivery" }),
  ).toBeVisible();
  await expect(page.getByText("Updating live")).toHaveCount(0);
});

test("keeps one Run live through every Gmail page and shows saved search inputs", async ({
  page,
}) => {
  const seed = await seedPagedVendorMailSearchRun(
    page,
    `Synthetic paged search ${Date.now()}`,
  );
  await gotoAuthenticatedPage(
    page,
    `/runs/${seed.runShortcode}`,
    page.getByRole("region", { name: "Search inputs" }),
  );
  await expect(
    page.getByRole("region", { name: "Search inputs" }),
  ).toContainText("example.test");
  await seed.firstPage();
  await expect(page.getByText("1 page scanned")).toBeVisible();
  await expect(page.getByText("Continuing to older messages")).toBeVisible();
  await expect(page.getByText("Run completed")).toHaveCount(0);
  await seed.lastPage();
  await expect(page.getByText("Run completed")).toBeVisible();
  await expect(page.getByText("2 pages scanned")).toBeVisible();
  await expect(page.getByText("13 messages checked")).toBeVisible();
  await page.reload();
  await expect(page.getByText("2 pages scanned")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Search inputs" }),
  ).toContainText("example.test");
});

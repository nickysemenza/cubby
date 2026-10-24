import { eq } from "drizzle-orm";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { writeOutcomeReceipts } from "~/server/domains/purchase-import/service/run-outcome.fixtures";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  createEvidenceHarnessContext,
  ensureMemberParty,
  createEntityFixture,
} from "./fixtures/core";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("a completed enrichment Run keeps attention, outcomes and source evidence accessible", async ({
  page,
}, testInfo) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  await ensureMemberParty(page, "Synthetic Run review");
  const lamp = await createEntityFixture(page, "product", {
    name: "Synthetic review lamp",
  });
  const chair = await createEntityFixture(page, "product", {
    name: "Synthetic review chair",
  });
  const runId = await ensureRun(db, actor, {
    purpose: "product_enrichment",
    trigger: "manual",
    status: "completed",
  });
  const lampId = await resolveOrThrow(db, "product", lamp.id);
  const chairId = await resolveOrThrow(db, "product", chair.id);
  await writeOutcomeReceipts(db, [
    {
      runId,
      entityKind: "product",
      entityId: lampId,
      targetFingerprint: "synthetic-lamp-v1",
      state: "needs_evidence",
      warning: "Model label needs a clearer photograph",
      outcome: "Identity evidence retained",
      diff: { model: { before: null, proposed: "Example 12" } },
    },
    {
      runId,
      entityKind: "product",
      entityId: chairId,
      targetFingerprint: "synthetic-chair-v1",
      state: "completed",
      outcome: "Identity confirmed from retained evidence",
    },
  ]);
  const [owner] = await getDb(db)
    .select({ shortcode: run.shortcode })
    .from(run)
    .where(eq(run.id, runId));
  if (!owner) throw new Error("Synthetic Run missing");
  await gotoAuthenticatedPage(page, `/runs/${owner.shortcode}#import-targets`);
  const table = page.getByRole("table", {
    name: "Items and outcomes",
    exact: true,
  });
  await expect(
    table.getByRole("row", { name: /Synthetic review lamp/ }),
  ).toBeVisible();
  await expect(
    table.getByRole("row", { name: /Synthetic review chair/ }),
  ).toHaveCount(0);
  await table.getByRole("row", { name: /Synthetic review lamp/ }).click();
  const inspector = page.getByRole("complementary", {
    name: "Run target evidence",
  });
  await expect(inspector).toContainText(
    "Model label needs a clearer photograph",
  );
  await expect(inspector).toContainText("Example 12");
  await expect(
    inspector.getByRole("link", { name: /Synthetic review lamp/ }),
  ).toHaveAttribute("href", `/products/${lamp.id}`);
  await page.screenshot({
    path: testInfo.outputPath("run-targets-desktop.png"),
  });
  await inspector.getByRole("button", { name: /close/i }).click();
  await page
    .getByTestId("run-targets")
    .getByRole("button", { name: "Results", exact: true })
    .click();
  await expect(
    table.getByRole("row", { name: /Synthetic review chair/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("link", { name: /Synthetic review lamp/ })
    .first()
    .scrollIntoViewIfNeeded();
  // The phone row opens the same evidence through the shared inspector sheet.
  await page
    .getByRole("button")
    .filter({ hasText: "Synthetic review lamp" })
    .first()
    .press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Run target evidence" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("run-targets-phone.png") });
});

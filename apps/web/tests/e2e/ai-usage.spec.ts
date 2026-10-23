import {
  aiUsageCacheStatus,
  aiUsageRecentOut,
  aiUsageTransport,
  aiUsageEntrySchema,
} from "@cubby/schemas/ai";
import { sql } from "drizzle-orm";

import { getDb } from "~/server/db/helpers";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { dispatchesOperation, operationResult } from "./support/dispatch-wire";
import {
  chooseOption,
  gotoAuthenticatedPage,
  selectComboboxItem,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { createEvidenceHarnessContext } from "./fixtures/core";

// Attribution must stay visible on failures; filtering must precede the recent
// row limit so an older subscription call is not hidden by newer Gateway calls.
test("recent AI calls filter transport and status before limiting rows", async ({
  page,
}) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });
  await getDb(db).execute(sql`
    INSERT INTO "AiUsage" (
      "runId", "feature", "provider", "model", "operation", "transport",
      "status", "durationMs", "standardCost", "chargedCost", "costEvidence", "createdAt"
    ) SELECT ${runId},
      CASE WHEN n = 0 THEN 'synthetic-legacy-feature' ELSE 'synthetic-attribution' END,
      CASE WHEN n = 0 THEN 'synthetic-legacy-provider' ELSE 'openai' END,
      CASE WHEN n = 0 THEN 'synthetic-legacy-model' ELSE 'gpt-6-luna' END,
      CASE WHEN n = 0 THEN 'synthetic.older-subscription' ELSE 'synthetic.newer-gateway' END,
      CASE WHEN n = 0 THEN ${aiUsageTransport.enum.chatgpt} ELSE ${aiUsageTransport.enum.gateway} END,
      CASE WHEN n = 0 THEN ${aiUsageEntrySchema.shape.status.enum.failed} ELSE ${aiUsageEntrySchema.shape.status.enum.succeeded} END,
      10, CASE WHEN n = 0 THEN 0.00123 ELSE 0.00000001 END,
      CASE WHEN n = 0 THEN 0 ELSE 0.00000001 END,
      CASE WHEN n = 0 THEN ${JSON.stringify({ standard: { source: "historical_recorded" }, charged: { source: "historical_recorded" }, billingReason: "plan" })}::jsonb
        ELSE ${JSON.stringify({ standard: { source: "historical_recorded" }, charged: { source: "historical_recorded" }, billingReason: "standard" })}::jsonb END,
      CASE WHEN n = 0 THEN now() - interval '120 days'
        ELSE now() - (60 - n) * interval '1 minute' END
    FROM generate_series(0, 60) n
  `);
  await gotoAuthenticatedPage(page, "/ai?tab=usage");
  const recent = page.getByRole("region", { name: "Recent calls" });
  await expect(
    recent.getByText("synthetic.newer-gateway").first(),
  ).toBeVisible();
  await expect(recent.getByText("synthetic.older-subscription")).toHaveCount(0);
  await expect(recent.getByText("<$0.000001 charged").first()).toBeVisible();

  const tinyCost = recent.getByText("<$0.000001 charged").first();
  // The spill overlay hides on scroll; settle the page before hovering so the
  // hover's own scroll-into-view cannot dismiss it.
  await tinyCost.scrollIntoViewIfNeeded();
  await tinyCost.hover();
  await expect(page.getByRole("tooltip")).toContainText("Charged: $0.00000001");
  await expect(page.locator("[data-cell-spill-overlay]")).toContainText(
    "$0.00000001 charged",
  );
  await page.getByRole("heading", { name: "AI", exact: true }).hover();
  await expect(page.locator("[data-cell-spill-overlay]")).toHaveCount(0);

  const filtered = page.waitForResponse((response) =>
    dispatchesOperation(response.request(), "ai.usageRecent", ({ input }) =>
      JSON.stringify(input).includes('"transport":"chatgpt"'),
    ),
  );
  await chooseOption(
    page,
    recent.getByRole("combobox", { name: "Transport" }),
    "ChatGPT plan",
  );
  const rows = await operationResult(
    await filtered,
    "ai.usageRecent",
    aiUsageRecentOut,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    transport: "chatgpt",
    status: "failed",
    standardCost: 0.00123,
    chargedCost: 0,
    costEvidence: { billingReason: "plan" },
  });
  const coveredRow = recent
    .getByRole("row")
    .filter({ hasText: "synthetic.older-subscription" });
  await expect(coveredRow.getByText(/0\.00123 standard/)).toBeVisible();
  await expect(coveredRow.getByText(/Plan covered/)).toBeVisible();
  await expect(recent.getByText("synthetic.older-subscription")).toBeVisible();
  await expect(recent.getByText("synthetic.newer-gateway")).toHaveCount(0);
  await chooseOption(
    page,
    recent.getByRole("combobox", { name: "Status" }),
    "Succeeded",
  );
  await expect(recent.getByText(/No recent calls/u)).toBeVisible();
  await chooseOption(
    page,
    recent.getByRole("combobox", { name: "Status" }),
    "Failed",
  );
  await expect(recent.getByText("synthetic.older-subscription")).toBeVisible();
  await recent
    .getByRole("textbox", { name: "Search recent calls" })
    .fill("no-matching-call");
  await expect(recent.getByText(/No recent calls/u)).toBeVisible();
  await recent.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(recent.getByRole("combobox", { name: "Transport" })).toHaveText(
    /All transports/,
  );
  await expect(recent.getByRole("combobox", { name: "Status" })).toHaveText(
    /All statuses/,
  );
  await expect(
    recent.getByText("synthetic.newer-gateway").first(),
  ).toBeVisible();
  await getDb(db).execute(sql`
    INSERT INTO "AiUsage" (
      "runId", "feature", "provider", "model", "operation", "transport",
      "status", "durationMs", "standardCost", "chargedCost", "costEvidence"
    ) VALUES (${runId}, 'synthetic-new-feature', 'synthetic-new-provider',
      'synthetic-new-model', 'synthetic.after-load', ${aiUsageTransport.enum.gateway}, ${aiUsageEntrySchema.shape.status.enum.succeeded}, 10, NULL, NULL, NULL)
  `);
  await recent.getByRole("button", { name: "Refresh recent calls" }).click();
  await selectComboboxItem(
    page,
    recent.getByRole("combobox", { name: "Provider" }),
    "synthetic-new-provider",
  );
  await expect(recent.getByText("synthetic.after-load")).toBeVisible();
  const unknownRow = recent
    .getByRole("row")
    .filter({ hasText: "synthetic.after-load" });
  await expect(unknownRow.getByText("unpriced charged")).toBeVisible();
  await expect(unknownRow.getByText("unpriced standard")).toBeVisible();
  await recent.getByRole("button", { name: "Clear", exact: true }).click();
});

// Savings are split by why the charge was lower, a failed call without usage
// is not an unpriced call, and the daily chart narrows the summary table.
test("daily cost chart splits savings and filters the summary table", async ({
  page,
}) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });
  const evidence = (billingReason: string) =>
    JSON.stringify({
      standard: { source: "estimate" },
      charged: { source: "estimate" },
      billingReason,
    });
  await getDb(db).execute(sql`
    INSERT INTO "AiUsage" (
      "runId", "feature", "provider", "model", "operation", "transport",
      "status", "durationMs", "inputTokens", "outputTokens", "standardCost",
      "chargedCost", "costEvidence", "applicationCacheStatus"
    ) VALUES
      (${runId}, 'synthetic-chart-paid', 'openai', 'gpt-6-luna', 'synthetic.paid',
        ${aiUsageTransport.enum.gateway}, ${aiUsageEntrySchema.shape.status.enum.succeeded},
        10, 100, 10, 0.05, 0.05, ${evidence("standard")}::jsonb, ${aiUsageCacheStatus.enum.none}),
      (${runId}, 'synthetic-chart-cached', 'typesafe', 'typesafe/jev', 'synthetic.cached',
        ${aiUsageTransport.enum.cache}, ${aiUsageEntrySchema.shape.status.enum.succeeded},
        10, 0, 0, 0.02, 0, ${evidence("cache")}::jsonb, ${aiUsageCacheStatus.enum.hit}),
      (${runId}, 'synthetic-chart-paid', 'openai', 'gpt-6-sol', 'synthetic.plan',
        ${aiUsageTransport.enum.chatgpt}, ${aiUsageEntrySchema.shape.status.enum.succeeded},
        10, 100, 10, 0.03, 0, ${evidence("plan")}::jsonb, ${aiUsageCacheStatus.enum.none}),
      (${runId}, 'synthetic-chart-paid', 'openai', 'gpt-6-sol', 'synthetic.failed',
        ${aiUsageTransport.enum.chatgpt}, ${aiUsageEntrySchema.shape.status.enum.failed},
        10, NULL, NULL, NULL, NULL, ${evidence("unknown")}::jsonb, ${aiUsageCacheStatus.enum.none})
  `);
  await gotoAuthenticatedPage(page, "/ai?tab=usage");

  await expect(page.getByText(/plan \$0\.03/)).toBeVisible();
  await expect(page.getByText(/cache \$0\.02/)).toBeVisible();
  await expect(page.getByText(/failed without usage/).first()).toBeVisible();

  const chart = page.getByRole("region", { name: "Cost by day" });
  const summary = page.getByRole("region", {
    name: "Usage by feature / model / day",
  });
  await expect(summary.getByText("synthetic-chart-cached")).toBeVisible();
  await chart.getByRole("button", { name: "synthetic-chart-paid" }).click();
  await expect(
    summary.getByText("Feature: synthetic-chart-paid"),
  ).toBeVisible();
  await expect(summary.getByText("synthetic-chart-cached")).toHaveCount(0);
  await summary.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(summary.getByText("synthetic-chart-cached")).toBeVisible();

  await chart.getByRole("button", { name: "Standard", exact: true }).click();
  for (const part of ["Charged", "Plan covered", "Cache"])
    await expect(
      chart.getByRole("listitem").getByText(part, { exact: true }),
    ).toBeVisible();
  await page.getByRole("button", { name: "30d" }).click();
  await chart.scrollIntoViewIfNeeded();
});

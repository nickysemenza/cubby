import {
  aiUsageRecentOut,
  aiUsageTransport,
  aiUsageEntrySchema,
} from "@cubby/schemas/ai";
import { sql } from "drizzle-orm";

import { getDb } from "~/server/repo/database-helpers";
import { ensureRun } from "~/server/runs/ensure-run";

import { dispatchesOperation, operationResult } from "./dispatch-wire";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { createEvidenceHarnessContext } from "./fixtures-core";

// Attribution must stay visible on failures; filtering must precede the recent
// row limit so an older subscription call is not hidden by newer Gateway calls.
test("recent AI calls filter transport and status before limiting rows", async ({
  page,
}, testInfo) => {
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

  // Full-history choices must remain available outside every summary window.
  for (const [label, value] of [
    ["Provider", "synthetic-legacy-provider"],
    ["Model", "synthetic-legacy-model"],
    ["Feature", "synthetic-legacy-feature"],
  ] as const) {
    await expect(
      recent
        .getByRole("combobox", { name: label })
        .locator("option", { hasText: value }),
    ).toHaveCount(1);
    await recent.getByRole("combobox", { name: label }).selectOption(value);
    await expect(
      recent.getByText("synthetic.older-subscription"),
    ).toBeVisible();
    await expect(recent.getByText("synthetic.newer-gateway")).toHaveCount(0);
    await recent.getByRole("button", { name: "Clear", exact: true }).click();
  }

  const filtered = page.waitForResponse((response) =>
    dispatchesOperation(response.request(), "ai.usageRecent", ({ input }) =>
      JSON.stringify(input).includes('"transport":"chatgpt"'),
    ),
  );
  await recent
    .getByRole("combobox", { name: "Transport" })
    .selectOption("chatgpt");
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
  await recent
    .getByRole("combobox", { name: "Status" })
    .selectOption("succeeded");
  await expect(recent.getByText(/No recent calls/u)).toBeVisible();
  await recent.getByRole("combobox", { name: "Status" }).selectOption("failed");
  await expect(recent.getByText("synthetic.older-subscription")).toBeVisible();
  await recent
    .getByRole("textbox", { name: "Search recent calls" })
    .fill("no-matching-call");
  await expect(recent.getByText(/No recent calls/u)).toBeVisible();
  await recent.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(recent.getByRole("combobox", { name: "Transport" })).toHaveValue(
    "",
  );
  await expect(recent.getByRole("combobox", { name: "Status" })).toHaveValue(
    "",
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
  await expect(
    recent
      .getByRole("combobox", { name: "Provider" })
      .locator("option", { hasText: "synthetic-new-provider" }),
  ).toHaveCount(1);
  await recent
    .getByRole("combobox", { name: "Provider" })
    .selectOption("synthetic-new-provider");
  await expect(recent.getByText("synthetic.after-load")).toBeVisible();
  const unknownRow = recent
    .getByRole("row")
    .filter({ hasText: "synthetic.after-load" });
  await expect(unknownRow.getByText("unpriced charged")).toBeVisible();
  await expect(unknownRow.getByText("unpriced standard")).toBeVisible();
  await recent.getByRole("button", { name: "Clear", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("ai-usage.png"),
    fullPage: true,
  });
});

import { aiUsageRecentOut } from "@cubby/schemas/ai";
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
      "status", "durationMs", "estimatedCost", "createdAt"
    ) SELECT ${runId}, 'synthetic-attribution', 'openai', 'gpt-6-luna',
      CASE WHEN n = 0 THEN 'synthetic.older-subscription' ELSE 'synthetic.newer-gateway' END,
      CASE WHEN n = 0 THEN 'chatgpt' ELSE 'gateway' END,
      CASE WHEN n = 0 THEN 'failed' ELSE 'succeeded' END,
      10, 0, now() - (60 - n) * interval '1 minute'
    FROM generate_series(0, 60) n
  `);
  await gotoAuthenticatedPage(page, "/ai-usage");
  const recent = page.getByRole("region", { name: "Recent calls" });
  await expect(
    recent.getByText("synthetic.newer-gateway").first(),
  ).toBeVisible();
  await expect(recent.getByText("synthetic.older-subscription")).toHaveCount(0);

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
  expect(rows[0]).toMatchObject({ transport: "chatgpt", status: "failed" });
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
  await page.screenshot({
    path: testInfo.outputPath("ai-usage.png"),
    fullPage: true,
  });
});

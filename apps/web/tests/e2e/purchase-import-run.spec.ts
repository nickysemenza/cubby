import { and, eq, inArray, sql } from "drizzle-orm";

import * as schema from "~/server/db/schema";
import {
  authorizePurchaseAgent,
  mailCommit,
  mailPrepare,
  readyExtraction,
} from "~/server/purchase-import/purchase-agent-workerd.fixtures";
import { getDb } from "~/server/repo/database-helpers";

import {
  call,
  currentRunId,
  mcpRead,
} from "../../tooling/purchase-agent-script";
import type { ScenarioControls } from "../../tooling/purchase-agent-workerd-harness";
import { fixtureUserId, getFixtureDb } from "./fixtures-core";
import { seedUnimportedOrderMail } from "./fixtures-mail";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// The Worker hosts the real import-run agent, its tools, MCP, and queue; only
// the coordinator model and the extractor/audit gateway are scripted. These
// prove the browser journey and its server writes, never model judgment.
test.use({ purchaseAgent: true });

const ORDERED_AT = "2026-09-10T15:00:00.000Z";
const herbPacket = (orderId: string, title: string, amount: number) => ({
  match: orderId,
  output: readyExtraction(orderId, ORDERED_AT, [
    { title, amount, lineKind: "principal", sku: `SKU-${orderId}` },
  ]),
});

/** Read-only verification the workflow asks for after each commit. */
const settlementRead = (id: string) =>
  mcpRead(id, "finance_read", { action: "statement_rows" });

function controls(purchaseAgent: ScenarioControls | undefined) {
  if (!purchaseAgent) throw new Error("The purchase-agent harness is off");
  return purchaseAgent;
}

async function vendorPurchases(
  vendorId: typeof schema.purchase.$inferSelect.vendorId,
) {
  const db = getDb(getFixtureDb());
  const purchases = await db
    .select({
      id: schema.purchase.id,
      shortcode: schema.purchase.shortcode,
      orderId: schema.purchase.orderId,
    })
    .from(schema.purchase)
    .where(eq(schema.purchase.vendorId, vendorId))
    .orderBy(schema.purchase.orderId);
  const ids = purchases.map(({ id }) => id);
  const expenses = ids.length
    ? await db
        .select({
          purchaseId: schema.expense.purchaseId,
          cost: schema.expense.cost,
          lineKind: schema.expense.lineKind,
          productId: schema.expense.productId,
        })
        .from(schema.expense)
        .where(inArray(schema.expense.purchaseId, ids))
    : [];
  const claims = ids.length
    ? await db
        .select({ purchaseId: schema.importSourceClaim.purchaseId })
        .from(schema.importSourceClaim)
        .where(inArray(schema.importSourceClaim.purchaseId, ids))
    : [];
  return { purchases, expenses, claims };
}

async function runByShortcode(shortcode: string) {
  const [run] = await getDb(getFixtureDb())
    .select({ id: schema.run.id, status: schema.run.status })
    .from(schema.run)
    .where(eq(schema.run.shortcode, shortcode));
  if (!run) throw new Error(`Run ${shortcode} was not saved`);
  return run;
}

test("imports saved order mail from the vendor page and follows the live Run to the committed Purchase", async ({
  page,
  e2eRuntime,
}) => {
  const agent = controls(e2eRuntime.purchaseAgent);
  const seed = await seedUnimportedOrderMail(
    page,
    `Synthetic import vendor ${Date.now()}`,
  );
  await authorizePurchaseAgent(getFixtureDb(), await fixtureUserId(page));
  await agent.configure({
    steps: [
      call("claim-1", "claim_next_import_work"),
      { check: "claim-1", includes: "mail_evidence" },
      call("extract-1", "extract_run_evidence"),
      mailPrepare("extract-1", "1", currentRunId),
      // Hold here so the browser watches the run mid-flight.
      { gate: "prepared" },
      mailCommit("extract-1", "1", currentRunId),
      // The identical commit under the same operation id is a replay.
      mailCommit("extract-1", "1", currentRunId, "commit-1-replay"),
      settlementRead("settlement-1"),
      call("claim-2", "claim_next_import_work"),
      { check: "claim-2", includes: "settlement_verification" },
      call("finish-1", "finish_import_run"),
    ],
    extractions: [herbPacket("SYN-CONFIRM-1", "Synthetic herb packet", 5)],
  });

  await gotoAuthenticatedPage(
    page,
    `/vendors/${seed.vendor.shortcode}`,
    page.getByText("Synthetic itemized confirmation"),
  );
  const article = page
    .getByRole("article")
    .filter({ hasText: "Synthetic itemized confirmation" });

  // The saved evidence changes after the page loaded: the server refuses the
  // stale checksum and the member refreshes before importing.
  const db = getDb(getFixtureDb());
  const [event] = await db
    .select({ orderMailId: schema.orderMailEvent.orderMailId })
    .from(schema.orderMailEvent)
    .where(eq(schema.orderMailEvent.id, seed.eventId));
  if (!event) throw new Error("Seeded order mail event is missing");
  const eventRuns = () =>
    db
      .select({ id: schema.run.id })
      .from(schema.run)
      .where(sql`${schema.run.input}->>'eventId' = ${seed.eventId}`);
  await db
    .update(schema.orderMail)
    .set({ rawChecksum: "b".repeat(64) })
    .where(eq(schema.orderMail.id, event.orderMailId));
  await article
    .getByRole("button", { name: "Import order", exact: true })
    .click();
  await expect(article.getByRole("alert")).toContainText(
    "Order email evidence changed; refresh before importing.",
  );
  expect(await eventRuns()).toEqual([]);

  await page.reload();
  await article
    .getByRole("button", { name: "Import order", exact: true })
    .click();
  const viewImport = article.getByRole("link", { name: "View import" });
  await expect(viewImport).toHaveAttribute("href", /^\/runs\/RUN-/u);
  await expect(
    article.getByRole("button", { name: "Import order", exact: true }),
  ).toHaveCount(0);
  const runShortcode = (await viewImport.getAttribute("href"))?.replace(
    "/runs/",
    "",
  );
  if (!runShortcode) throw new Error("View import has no Run");
  await viewImport.click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runShortcode}$`, "u"));

  // Mid-flight: the conversation streams in and progress shows the prepared
  // order; nothing is imported until the commit.
  await expect(page.getByText("live", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Working through purchase evidence"),
  ).toBeVisible();
  await expect(page.getByText("0 orders seen · 0 imported")).toBeVisible();
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "order:SYN-CONFIRM-1" })
      .filter({ hasText: "1 lines" }),
  ).toBeVisible();
  await page.getByText(/^Agent messages and tool calls/u).click();
  const transcript = page.getByLabel("Agent conversation transcript");
  await expect(
    transcript.getByText("mcp__cubby__purchase_import · output-available"),
  ).toHaveCount(1);
  await expect(transcript.getByText(/^finish_import_run/u)).toHaveCount(0);

  await agent.release("prepared");

  // Without a reload, the stream and run read reach completion.
  await expect(page.getByText("Purchase import complete")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("1 order seen · 1 imported")).toBeVisible();
  await page.getByText(/^Agent messages and tool calls/u).click();
  await expect(
    page
      .getByLabel("Agent conversation transcript")
      .getByText("finish_import_run · output-available"),
  ).toBeVisible();

  const run = await runByShortcode(runShortcode);
  expect(run.status).toBe("completed");
  const graph = await vendorPurchases(seed.vendor.id);
  expect(graph.purchases).toMatchObject([{ orderId: "SYN-CONFIRM-1" }]);
  expect(graph.expenses).toMatchObject([{ cost: 5, lineKind: "principal" }]);
  expect(graph.expenses[0]?.productId).not.toBeNull();
  expect(graph.claims).toHaveLength(1);
  // The replayed commit is one completed operation, not a second write.
  expect(
    await db
      .select({ state: schema.runOperation.state })
      .from(schema.runOperation)
      .where(
        and(
          eq(schema.runOperation.runId, run.id),
          eq(schema.runOperation.operationId, "commit-1"),
        ),
      ),
  ).toEqual([{ state: "completed" }]);
  expect(await agent.violations()).toEqual([]);

  const [purchase] = graph.purchases;
  if (!purchase) throw new Error("No Purchase was committed");
  await gotoAuthenticatedPage(
    page,
    `/purchases/${purchase.shortcode}`,
    page.getByText("Synthetic herb packet").first(),
  );
  await expect(page.getByText("SYN-CONFIRM-1").first()).toBeVisible();
  await expect(page.getByText("$5.00").first()).toBeVisible();
});

test("imports several selected confirmations in one Run", async ({
  page,
  e2eRuntime,
}) => {
  const agent = controls(e2eRuntime.purchaseAgent);
  const seed = await seedUnimportedOrderMail(
    page,
    `Synthetic selected import vendor ${Date.now()}`,
    3,
  );
  const [first, , third] = seed.events;
  if (!first || !third) throw new Error("Missing seeded confirmations");
  await authorizePurchaseAgent(getFixtureDb(), await fixtureUserId(page));
  await agent.configure({
    steps: [1, 2]
      .flatMap((n) => [
        call(`claim-${n}`, "claim_next_import_work"),
        { check: `claim-${n}`, includes: "mail_evidence" },
        call(`extract-${n}`, "extract_run_evidence"),
        mailPrepare(`extract-${n}`, String(n), currentRunId),
        mailCommit(`extract-${n}`, String(n), currentRunId),
        settlementRead(`settlement-${n}`),
      ])
      .concat([
        call("claim-done", "claim_next_import_work"),
        call("finish-1", "finish_import_run"),
      ]),
    extractions: [
      herbPacket(first.orderId, "Synthetic basil packet", 5),
      herbPacket(third.orderId, "Synthetic thyme packet", 7),
    ],
  });

  await gotoAuthenticatedPage(
    page,
    `/vendors/${seed.vendor.shortcode}`,
    page.getByText("Synthetic itemized confirmation", { exact: true }),
  );
  for (const order of [first, third])
    await page
      .getByRole("checkbox", {
        name: `Select order ${order.orderId} to import with others`,
      })
      .click();
  await page.getByRole("button", { name: "Import selected (2)" }).click();
  const viewImport = page.getByRole("link", { name: "View selected import" });
  await expect(viewImport).toHaveAttribute("href", /^\/runs\/RUN-/u);
  await viewImport.click();
  await expect(page.getByText("Purchase import complete")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("2 orders seen · 2 imported")).toBeVisible();

  const graph = await vendorPurchases(seed.vendor.id);
  expect(graph.purchases.map(({ orderId }) => orderId)).toEqual([
    first.orderId,
    third.orderId,
  ]);
  expect(graph.expenses.map(({ cost }) => cost).sort()).toEqual([5, 7]);
  expect(await agent.violations()).toEqual([]);
});

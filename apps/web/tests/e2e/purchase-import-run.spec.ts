import { orderMailImportOut } from "@cubby/schemas/order-mail-review";
import { sha256Hex } from "@cubby/shared/sha256";
import superjson from "superjson";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";

import * as schema from "~/server/db/schema";
import {
  authorizeSyntheticBackfill,
  authorizePurchaseAgent,
  workerdDiagnostic,
} from "~/server/purchase-import/purchase-agent-workerd.fixtures";
import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { getDb } from "~/server/repo/database-helpers";

import {
  call,
  from,
  mcp,
  mcpRead,
  type ScriptStep,
  type ScriptValue,
} from "../../tooling/purchase-agent-script";
import type { ScenarioControls } from "../../tooling/purchase-agent-workerd-harness";
import {
  createEvidenceHarnessContext,
  fixtureUserId,
  getFixtureDb,
} from "./fixtures-core";
import { seedUnimportedOrderMail } from "./fixtures-mail";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Only external model judgment is scripted. Admission, Pi's tools, in-process
// MCP (imports_read.mail, purchase_import, mail.resolve), the report commands
// and the writer run in the Worker.
test.use({ workerdProfile: "purchase-agent" });

type Seed = Awaited<ReturnType<typeof seedUnimportedOrderMail>>;

type Source = { mailboxId: string; messageId: string; orderId: string };

/** Claim the next Email, read it, then prepare and commit its one order. */
function importOrder(
  prefix: string,
  { vendor, itemTitle }: Seed,
  source: Source,
  options: { gate?: string; productId?: ScriptValue } = {},
): ScriptStep[] {
  const checksum = from(`${prefix}-read`, "checksum");
  return [
    call(`${prefix}-claim`, "claim_next_import_work"),
    { check: `${prefix}-claim`, includes: source.messageId },
    mcpRead(`${prefix}-read`, "imports_read", {
      action: "mail",
      mailboxId: source.mailboxId,
      messageId: source.messageId,
    }),
    ...(options.gate ? [{ gate: options.gate }] : []),
    mcp(
      `${prefix}-prepare`,
      "purchase_import",
      { $runId: true },
      {
        action: "prepare",
        orders: [
          {
            vendorId: vendor.shortcode,
            stableOrderId: `${prefix}-order`,
            itemOperationId: `${prefix}-prepare:order`,
            source: {
              kind: "mail_message",
              externalKey: `gmail:${source.mailboxId}:${source.messageId}`,
              checksum,
            },
            evidenceChecksum: checksum,
            extractionRevision: "synthetic@1",
            extraction: {
              status: "ready",
              candidate: {
                orderId: source.orderId,
                orderedAt: "2026-09-10T15:00:00.000Z",
                merchant: vendor.name,
                currency: "USD",
                printedGrandTotal: 5,
                lines: [
                  {
                    title: itemTitle,
                    amount: 5,
                    lineKind: "principal",
                    quantity: 1,
                    sku: "HERB-1",
                  },
                ],
                payments: [],
                allShipmentsDelivered: false,
              },
            },
            lineIds: [`${prefix}-order:line-1`],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      },
    ),
    mcp(
      `${prefix}-commit`,
      "purchase_import",
      { $runId: true },
      {
        action: "commit",
        prepareOperationId: `${prefix}-prepare`,
        defaultTrade: "other",
        resolutions: [
          {
            stableOrderId: `${prefix}-order`,
            stableLineId: `${prefix}-order:line-1`,
            resolution: options.productId
              ? { kind: "existing", productId: options.productId }
              : { kind: "new" },
          },
        ],
      },
    ),
    { check: `${prefix}-commit`, includes: "created" },
  ];
}
/** Retained originals in the order Pi claims them (received time, then id). */
async function claimOrder(seed: Seed): Promise<Source[]> {
  const rows = await getDb(getFixtureDb())
    .select()
    .from(schema.orderMail)
    .where(
      inArray(
        schema.orderMail.id,
        seed.events.map(({ orderMailId }) => orderMailId),
      ),
    )
    .orderBy(schema.orderMail.receivedAt, schema.orderMail.id);
  return rows.map((row) => ({
    mailboxId: row.mailboxId,
    messageId: row.messageId,
    orderId: seed.events.find((event) => event.orderMailId === row.id)!.orderId,
  }));
}
const finished = (prefix: string): ScriptStep[] => [
  call(`${prefix}-done`, "claim_next_import_work"),
  { check: `${prefix}-done`, includes: "none" },
];

function controls(purchaseAgent: ScenarioControls | undefined) {
  if (!purchaseAgent) throw new Error("The purchase-agent harness is off");
  return purchaseAgent;
}

async function authorizeSeed(
  context: Awaited<ReturnType<typeof createEvidenceHarnessContext>>,
  seed: Seed,
) {
  const [source] = await getDb(context.db)
    .select()
    .from(schema.orderMail)
    .where(eq(schema.orderMail.id, seed.events[0]!.orderMailId));
  if (!source) throw new Error("Synthetic original is missing");
  return authorizeSyntheticBackfill(context, seed.member.id, source.mailboxId);
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
        .select({
          purchaseId: schema.importSourceOrder.purchaseId,
          externalKey: schema.importSourceClaim.externalKey,
        })
        .from(schema.importSourceOrder)
        .innerJoin(
          schema.importSourceClaim,
          eq(
            schema.importSourceClaim.id,
            schema.importSourceOrder.sourceClaimId,
          ),
        )
        .where(inArray(schema.importSourceOrder.purchaseId, ids))
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

async function completedRun(shortcode: string) {
  const run = await runByShortcode(shortcode);
  if (["failed", "needs_review"].includes(run.status))
    throw new Error(await workerdDiagnostic(getFixtureDb(), run.id, undefined));
  return run.status;
}

test("imports saved order mail from the generic Vendor report and follows the live Run to the committed Purchase", async ({
  page,
  e2eRuntime,
}) => {
  const agent = controls(e2eRuntime.purchaseAgent);
  const seed = await seedUnimportedOrderMail(
    page,
    `Synthetic import vendor ${Date.now()}`,
  );
  await authorizePurchaseAgent(getFixtureDb(), await fixtureUserId(page));
  await authorizeSeed(await createEvidenceHarnessContext(page), seed);
  const [claimed] = await claimOrder(seed);
  if (!claimed) throw new Error("Seeded original is missing");
  await agent.configure({
    expectedInference: { model: "gpt-6-luna", effort: "medium" },
    steps: [
      ...importOrder("mail", seed, claimed, { gate: "original-read" }),
      ...finished("mail"),
    ],
  });
  await gotoAuthenticatedPage(
    page,
    `/vendors/${seed.vendor.shortcode}`,
    page.getByText("Synthetic itemized confirmation", { exact: true }),
  );
  const original = page
    .getByRole("listitem")
    .filter({ hasText: "Synthetic itemized confirmation" });
  const db = getDb(getFixtureDb());
  const [source] = await db
    .select()
    .from(schema.orderMail)
    .where(eq(schema.orderMail.id, seed.events[0]!.orderMailId));
  if (!source?.content?.bodyText) throw new Error("Seeded original is missing");
  // A changed original refuses the stale command and admits nothing.
  const bodyText = `${source.content.bodyText} Reference reissued.`;
  const checksum = await sha256Hex(bodyText);
  await db
    .update(schema.orderMail)
    .set({ rawChecksum: checksum, content: { ...source.content, bodyText } })
    .where(eq(schema.orderMail.id, source.id));
  await db
    .update(schema.mailboxMessage)
    .set({ checksum })
    .where(eq(schema.mailboxMessage.orderMailId, source.id));
  await original
    .getByRole("button", { name: "Research original", exact: true })
    .click();
  await expect(
    page.getByText(
      "Order email evidence changed; refresh before researching.",
      { exact: false },
    ),
  ).toBeVisible();
  expect(
    await db
      .select({ runId: schema.mailboxMessage.runId })
      .from(schema.mailboxMessage)
      .where(eq(schema.mailboxMessage.orderMailId, source.id)),
  ).toEqual([{ runId: null }]);

  await page.reload();
  await original
    .getByRole("button", { name: "Research original", exact: true })
    .click();
  const runLink = original.getByRole("link").filter({ hasText: /^RUN-/u });
  await expect(runLink).toHaveAttribute("href", /^\/runs\/RUN-/u);
  const runShortcode = (await runLink.getAttribute("href"))?.replace(
    "/runs/",
    "",
  );
  if (!runShortcode) throw new Error("Import result has no Run");
  await runLink.click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runShortcode}$`, "u"));
  await expect(
    page.getByText(/^(Updating live|Last update .+ ago)$/u),
  ).toBeVisible();
  await expect.poll(async () => agent.emitted()).toContain("mail-read");
  expect((await vendorPurchases(seed.vendor.id)).purchases).toEqual([]);
  await agent.release("original-read");
  await expect
    .poll(async () => completedRun(runShortcode), { timeout: 30_000 })
    .toBe("completed");
  const run = await runByShortcode(runShortcode);
  const graph = await vendorPurchases(seed.vendor.id);
  expect(graph.purchases).toMatchObject([{ orderId: "SYN-CONFIRM-1" }]);
  expect(graph.expenses).toMatchObject([{ cost: 5, lineKind: "principal" }]);
  expect(graph.claims).toEqual([
    {
      purchaseId: graph.purchases[0]!.id,
      externalKey: `gmail:${source.mailboxId}:${source.messageId}`,
    },
  ]);
  expect(
    await db
      .select({
        runId: schema.mailboxMessage.runId,
        status: schema.mailboxMessage.status,
        checksum: schema.mailboxMessage.checksum,
      })
      .from(schema.mailboxMessage)
      .where(eq(schema.mailboxMessage.orderMailId, source.id)),
  ).toEqual([{ runId: run.id, status: "completed", checksum }]);
  expect(
    await db
      .select({ state: schema.runTarget.state })
      .from(schema.runTarget)
      .where(eq(schema.runTarget.runId, run.id)),
  ).toEqual([{ state: "completed" }]);
  const productId = graph.expenses[0]?.productId;
  if (!productId) throw new Error("The imported line has no Product");
  expect(
    await db
      .select({ id: schema.inventoryEntry.id })
      .from(schema.inventoryEntry)
      .where(eq(schema.inventoryEntry.productId, productId)),
  ).toEqual([]);
  expect(await agent.violations()).toEqual([]);
  const purchase = graph.purchases[0];
  if (!purchase) throw new Error("No Purchase was committed");
  await gotoAuthenticatedPage(
    page,
    `/purchases/${purchase.shortcode}`,
    page.getByText(seed.itemTitle).first(),
  );
  await expect(page.getByText("SYN-CONFIRM-1").first()).toBeVisible();
  await expect(page.getByText("$5.00").first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open Gmail original" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: `Research ${runShortcode}` }),
  ).toHaveAttribute("href", `/runs/${runShortcode}`);
});

test("admits several retained confirmations as separate tasks in the same Run", async ({
  page,
  e2eRuntime,
}) => {
  const agent = controls(e2eRuntime.purchaseAgent);
  const seed = await seedUnimportedOrderMail(
    page,
    `Synthetic batch import vendor ${Date.now()}`,
    2,
  );
  await authorizePurchaseAgent(getFixtureDb(), await fixtureUserId(page));
  await authorizeSeed(await createEvidenceHarnessContext(page), seed);
  const [first, second] = await claimOrder(seed);
  if (!first || !second) throw new Error("Missing seeded confirmations");
  await agent.configure({
    steps: [
      ...importOrder("first", seed, first, { gate: "batch-admitted" }),
      // The second order reuses the Product the first created: prepare
      // returns it as the line's candidate.
      ...importOrder("second", seed, second, {
        productId: from(
          "second-prepare",
          "orders.0.lines.0.candidates.0.productId",
        ),
      }),
      ...finished("batch"),
    ],
  });
  const response = await page.request.post(BROWSER_OPERATION_PATH, {
    headers: { Origin: e2eRuntime.baseURL },
    data: superjson.serialize({
      operation: "vendor.importSelectedOrderMail",
      input: {
        orders: seed.events.map(({ eventId, checksum }) => ({
          eventId,
          evidenceChecksum: checksum,
        })),
      },
    }),
  });
  expect(response.status(), await response.text()).toBe(200);
  const { runIds } = z
    .object({ ok: z.literal(true), data: orderMailImportOut })
    .parse(superjson.deserialize(await response.json())).data;
  expect(runIds).toHaveLength(1);
  const runShortcode = runIds[0]!;
  const run = await runByShortcode(runShortcode);
  const db = getDb(getFixtureDb());
  // One RunTarget per admitted Email.
  expect(
    await db
      .select({ workKey: schema.runTarget.workKey })
      .from(schema.runTarget)
      .where(eq(schema.runTarget.runId, run.id)),
  ).toEqual(
    expect.arrayContaining(
      seed.events.map(({ orderMailId }) => ({ workKey: orderMailId })),
    ),
  );
  await gotoAuthenticatedPage(
    page,
    `/vendors/${seed.vendor.shortcode}`,
    page.getByRole("link", { name: `Research ${runShortcode}` }).first(),
  );
  await page
    .getByRole("link", { name: `Research ${runShortcode}` })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runShortcode}$`, "u"));
  await agent.release("batch-admitted");
  await expect
    .poll(async () => completedRun(runShortcode), { timeout: 30_000 })
    .toBe("completed");
  const graph = await vendorPurchases(seed.vendor.id);
  expect(graph.purchases.map(({ orderId }) => orderId)).toEqual(
    seed.events.map(({ orderId }) => orderId).sort(),
  );
  expect(graph.expenses.map(({ cost }) => cost)).toEqual([5, 5]);
  expect(new Set(graph.expenses.map(({ productId }) => productId)).size).toBe(
    1,
  );
  expect(graph.claims).toHaveLength(2);
  const owned = await db
    .select({
      orderMailId: schema.mailboxMessage.orderMailId,
      runId: schema.mailboxMessage.runId,
      status: schema.mailboxMessage.status,
    })
    .from(schema.mailboxMessage)
    .where(
      inArray(
        schema.mailboxMessage.orderMailId,
        seed.events.map(({ orderMailId }) => orderMailId),
      ),
    );
  expect(owned).toHaveLength(2);
  expect(owned).toEqual(
    expect.arrayContaining(
      seed.events.map(({ orderMailId }) => ({
        orderMailId,
        runId: run.id,
        status: "completed",
      })),
    ),
  );
  expect(await agent.violations()).toEqual([]);
});

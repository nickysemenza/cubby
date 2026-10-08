import { orderMailImportOut } from "@cubby/schemas/order-mail-review";
import { sha256Hex } from "@cubby/shared/sha256";
import superjson from "superjson";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";

import * as schema from "~/server/db/schema";
import { authorizePurchaseAgent } from "~/server/purchase-import/purchase-agent-workerd.fixtures";
import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { getDb } from "~/server/repo/database-helpers";

import {
  from,
  type ScriptStep,
  type ScriptValue,
} from "../../tooling/purchase-agent-script";
import type { ScenarioControls } from "../../tooling/purchase-agent-workerd-harness";
import { fixtureUserId, getFixtureDb } from "./fixtures-core";
import { seedUnimportedOrderMail } from "./fixtures-mail";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Only external model judgment is scripted. The shared admission, researcher
// tools, retained source checks, report commands and writer run in the Worker.
test.use({ workerdProfile: "purchase-agent" });

const step = (
  id: string,
  tool: string,
  args: Record<string, ScriptValue> = {},
): ScriptStep => ({ call: id, tool, args });
const researchOrder = (
  prefix: string,
  vendor: Awaited<ReturnType<typeof seedUnimportedOrderMail>>["vendor"],
  orderId: string,
  gate?: string,
): ScriptStep[] => [
  step(`${prefix}-next`, "work_next"),
  step(`${prefix}-read`, "mail_read", {
    workRef: from(`${prefix}-next`, "work.workRef"),
    messageRef: from(`${prefix}-next`, "work.sources.0.messageRef"),
  }),
  ...(gate ? [{ gate }] : []),
  step(`${prefix}-resolve`, "work_resolve", {
    workRef: from(`${prefix}-next`, "work.workRef"),
    status: "verified",
    identity: {
      evidenceIds: [from(`${prefix}-read`, "evidenceId")],
      reasoning:
        "The retained itemized original identifies this order and its printed total.",
    },
    orders: [
      {
        vendorRef: vendor.shortcode,
        evidenceIds: [from(`${prefix}-read`, "evidenceId")],
        reasoning: `The original supports ${orderId}, one herb packet and its printed five-dollar total.`,
        candidate: {
          orderId,
          orderedAt: "2026-09-10T15:00:00Z",
          merchant: vendor.name,
          currency: "USD",
          printedGrandTotal: 5,
          lines: [
            {
              title: "Synthetic herb packet",
              amount: 5,
              lineKind: "principal",
              quantity: 1,
              sku: "HERB-1",
            },
          ],
          payments: [],
          allShipmentsDelivered: false,
        },
        productResolutions: [{ kind: "new", lineIndex: 0 }],
        defaultTrade: "other",
      },
    ],
    detail: `Imported ${orderId} from the retained original without receiving stock.`,
  }),
];
const supportedOrder = {
  identityVerified: true,
  acceptedFacts: [],
  acceptedIdentifiers: [],
  acceptedImages: [],
  acceptedOrders: [0],
  acceptedEmailLinks: [],
  rejected: [],
};
const productGapSteps: ScriptStep[] = [
  step("product-next", "work_next"),
  step("product-gap", "work_resolve", {
    workRef: from("product-next", "work.workRef"),
    status: "no_source_found",
    identity: {
      evidenceIds: [],
      reasoning:
        "Synthetic catalog gap: this fixture supplies no catalog original.",
    },
    detail: "Synthetic catalog gap: no product enrichment source was supplied.",
  }),
];

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
        .select({
          purchaseId: schema.importSourceOrder.purchaseId,
          sourceClaimId: schema.importSourceClaim.id,
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
  await agent.configure({
    steps: researchOrder("mail", seed.vendor, "SYN-CONFIRM-1", "original-read"),
    purposeSteps: { product_enrichment: productGapSteps },
    assessments: [
      { match: "printed five-dollar total", output: supportedOrder },
      {
        match: "Synthetic catalog gap",
        output: {
          ...supportedOrder,
          identityVerified: false,
          acceptedOrders: [],
        },
      },
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
  if (!runShortcode) throw new Error("Research result has no Run");
  await runLink.click();
  await expect(page).toHaveURL(new RegExp(`/runs/${runShortcode}$`, "u"));
  await expect(page.getByText("live", { exact: true })).toBeVisible();
  await expect.poll(async () => agent.emitted()).toContain("mail-read");
  expect((await vendorPurchases(seed.vendor.id)).purchases).toEqual([]);
  await agent.release("original-read");
  await expect
    .poll(async () => (await runByShortcode(runShortcode)).status, {
      timeout: 30_000,
    })
    .toBe("completed");
  const run = await runByShortcode(runShortcode);
  const graph = await vendorPurchases(seed.vendor.id);
  expect(graph.purchases).toMatchObject([{ orderId: "SYN-CONFIRM-1" }]);
  expect(graph.expenses).toMatchObject([{ cost: 5, lineKind: "principal" }]);
  expect(graph.claims).toHaveLength(1);
  expect(graph.claims[0]?.externalKey).toBe(
    `gmail:${source.mailboxId}:${source.messageId}`,
  );
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
    page.getByText("Synthetic herb packet").first(),
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

test("admits several retained confirmations as separate tasks in the same research Run", async ({
  page,
  e2eRuntime,
}) => {
  const agent = controls(e2eRuntime.purchaseAgent);
  const seed = await seedUnimportedOrderMail(
    page,
    `Synthetic batch import vendor ${Date.now()}`,
    2,
  );
  const [first, second] = seed.events;
  if (!first || !second) throw new Error("Missing seeded confirmations");
  await authorizePurchaseAgent(getFixtureDb(), await fixtureUserId(page));
  await agent.configure({
    steps: researchOrder("first", seed.vendor, first.orderId).slice(0, 2),
    sourceSteps: [
      ...seed.events.map(({ orderId }) => ({
        call: "second-read",
        path: "readableText",
        includes: orderId,
        steps: researchOrder("second", seed.vendor, orderId).slice(2),
      })),
      ...seed.events.map(({ orderId }) => ({
        call: "first-read",
        path: "readableText",
        includes: orderId,
        steps: [
          { gate: "batch-admitted" },
          ...researchOrder("first", seed.vendor, orderId).slice(2),
          ...researchOrder("second", seed.vendor, orderId).slice(0, 2),
        ],
      })),
    ],
    purposeSteps: { product_enrichment: productGapSteps },
    assessments: [
      { match: "printed five-dollar total", output: supportedOrder },
      {
        match: "Synthetic catalog gap",
        output: {
          ...supportedOrder,
          identityVerified: false,
          acceptedOrders: [],
        },
      },
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
  expect(
    await db
      .select({ sourceId: schema.runTarget.sourceExternalKey })
      .from(schema.runTarget)
      .where(eq(schema.runTarget.runId, run.id)),
  ).toEqual(
    expect.arrayContaining(
      seed.events.map(({ orderMailId }) => ({ sourceId: orderMailId })),
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
    .poll(async () => (await runByShortcode(runShortcode)).status, {
      timeout: 30_000,
    })
    .toBe("completed");
  const graph = await vendorPurchases(seed.vendor.id);
  expect(graph.purchases.map(({ orderId }) => orderId)).toEqual([
    first.orderId,
    second.orderId,
  ]);
  expect(graph.expenses.map(({ cost }) => cost)).toEqual([5, 5]);
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

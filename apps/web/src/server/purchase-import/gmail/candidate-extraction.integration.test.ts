/** Related classification-only ingestion must preview parsed evidence without
 * admitting import work; selection cannot survive a persisted source change. */
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  email as emailTable,
  purchase,
  expense,
  run as runTable,
  importSourceClaim,
  emailCandidateObservation,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { ingestGmailMessages } from "./ingest";
import type { GmailProvider } from "./types";
const html =
  '<script type="application/ld+json">' +
  JSON.stringify({
    "@type": "Order",
    orderNumber: "SYNTHETIC-ORDER",
    orderDate: "2026-10-01",
    seller: { name: "Synthetic shop" },
    priceCurrency: "USD",
    price: "8.00",
    orderedItem: [
      {
        orderQuantity: 2,
        orderedItem: {
          name: "Synthetic basil",
          offers: { price: "4.00", priceCurrency: "USD" },
        },
      },
    ],
  }) +
  "</script>";
const gmail: GmailProvider = {
  getProfile: async () => ({ historyId: "100" }),
  listMessages: async () => ({}),
  listHistory: async () => ({}),
  getAttachment: async () => ({}),
  getMessage: async (id) => ({
    id,
    payload: {
      mimeType: "text/html",
      headers: [{ name: "Subject", value: "Synthetic receipt" }],
      body: { data: Buffer.from(html).toString("base64url") },
    },
  }),
};
const storage = {
  put: async () => undefined,
  get: async () => new Uint8Array(),
  delete: async () => undefined,
};
describe("read-only Gmail candidate production wiring", () => {
  const ctx = withTestDb();
  async function setup() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic candidate member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "manual",
      status: "running",
      input: {
        mailboxId: "synthetic-mailbox",
        scopedQueries: [],
        executionPolicy: "classification_only",
      },
    });
    return {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageIds: ["synthetic-message"],
      runId,
      storage,
      triage: async () => "related" as const,
    };
  }
  it("previews a related classification-only Email through its bounded candidate model seam without ledger writes or import admission", async () => {
    const input = await setup();
    let calls = 0;
    const outcome = await ingestGmailMessages(ctx.db, gmail, {
      ...input,
      candidateChoice: async () => {
        calls++;
        return { selectedIndex: 0, confidence: "high", probability: 0.95 };
      },
    });
    expect(calls).toBe(1);
    const predictions = await getDb(ctx.db)
      .select()
      .from(emailCandidateObservation);
    expect(predictions).toHaveLength(1);
    await ingestGmailMessages(ctx.db, gmail, {
      ...input,
      candidateChoice: async () => ({
        selectedIndex: 0,
        confidence: "high",
        probability: 0.95,
      }),
    });
    expect(
      await getDb(ctx.db).select().from(emailCandidateObservation),
    ).toEqual(predictions);
    expect(outcome.candidatePreviews).toMatchObject([
      {
        preview: {
          status: "selected",
          candidate: {
            extraction: {
              status: "ready",
              candidate: { orderId: "SYNTHETIC-ORDER", printedGrandTotal: 8 },
            },
          },
        },
      },
    ]);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
    expect(
      (await getDb(ctx.db).select().from(runTable)).map((row) => row.purpose),
    ).toEqual(["mail_discovery"]);
  });
  it("refuses a selected candidate when persisted Email source identity changes during the decision", async () => {
    const input = await setup();
    await expect(
      ingestGmailMessages(ctx.db, gmail, {
        ...input,
        candidateChoice: async () => {
          await getDb(ctx.db)
            .update(emailTable)
            .set({ checksum: "b".repeat(64) })
            .where(eq(emailTable.messageId, "synthetic-message"));
          return { selectedIndex: 0, confidence: "high", probability: 0.95 };
        },
      }),
    ).rejects.toThrow("source changed");
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(
      await getDb(ctx.db).select().from(emailCandidateObservation),
    ).toEqual([]);
  });
  it("keeps unrelated structured email headers without parsing, model calls, candidate history or retained body", async () => {
    const input = await setup();
    let calls = 0;
    const result = await ingestGmailMessages(ctx.db, gmail, {
      ...input,
      triage: async () => "unrelated",
      candidateChoice: async () => {
        calls++;
        return { selectedIndex: 0, confidence: "high", probability: 0.95 };
      },
    });
    expect(calls).toBe(0);
    expect(result.unrelated).toEqual(["synthetic-message"]);
    expect(
      await getDb(ctx.db).select().from(emailCandidateObservation),
    ).toEqual([]);
    const [email] = await getDb(ctx.db).select().from(emailTable);
    expect(email).toMatchObject({
      subject: "Synthetic receipt",
      classification: "unrelated",
      orderMailId: null,
    });
  });
});

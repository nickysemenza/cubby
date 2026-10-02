import { buildActorContext } from "@cubby/schemas/context";
import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  runVendorMailSearchJob,
  startVendorMailSearchJob,
} from "~/server/purchase-import/gmail/search-job";
import {
  getFixtureDb,
  fixtureUserId,
  ensureMemberParty,
} from "./fixtures-core";

/** A synthetic recognized email with one exact Purchase candidate. */
export async function seedVendorMailReviewPrerequisite(
  page: Page,
  name: string,
) {
  const db = getFixtureDb();
  const member = await ensureMemberParty(page, name);
  const vendor = await insertWithShortcode(db, "vendor", { name });
  const purchase = await insertWithShortcode(db, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-ORDER-1001",
    date: "2026-09-10",
    statedTotal: 48,
  });
  await insertWithShortcode(db, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-OTHER-2002",
    date: "2026-09-09",
    statedTotal: 19,
  });
  await insertWithShortcode(db, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-OTHER-3003",
    date: "2026-09-08",
    statedTotal: 48,
  });
  const [mail] = await getDb(db)
    .insert(schema.orderMail)
    .values({
      ledgerPartyId: member.id,
      vendorId: vendor.id,
      messageId: `synthetic-message-${crypto.randomUUID()}`,
      threadId: `synthetic-thread-${crypto.randomUUID()}`,
      sender: "Synthetic Outfitters <orders@example.test>",
      subject: "Synthetic order receipt",
      receivedAt: new Date("2026-09-10T15:00:00.000Z"),
      rawChecksum: "synthetic-mail-checksum",
    })
    .returning({ id: schema.orderMail.id });
  if (!mail) throw new Error("Synthetic mail was not saved");
  await getDb(db).insert(schema.orderMailEvent).values({
    orderMailId: mail.id,
    event: "placed",
    orderId: "SYN-ORDER-1001",
    amount: 48,
    currency: "USD",
    sourceKey: "classified:synthetic-mail-checksum:0",
  });
  return { vendor, purchase };
}

/** A failed Gmail search with its diagnostic stored only on the job row. */
export async function seedFailedVendorMailSearchRun(page: Page, name: string) {
  const db = getFixtureDb();
  const userId = await fixtureUserId(page);
  await ensureMemberParty(page, name);
  const vendor = await insertWithShortcode(db, "vendor", {
    name,
    website: "https://example.test",
  });
  const started = await startVendorMailSearchJob(
    db,
    { vendorId: vendor.shortcode },
    buildActorContext(userId),
    { publish: async () => ({ transport: "queue", count: 1 }) },
  );
  const [savedRun] = await getDb(db)
    .select({ id: schema.run.id })
    .from(schema.run)
    .where(eq(schema.run.shortcode, started.runShortcode))
    .limit(1);
  if (!savedRun) throw new Error("Synthetic Gmail search Run was not saved");
  await runVendorMailSearchJob(db, savedRun.id, {
    reportError: () => "ffffffffffffffffffffffffffffffff",
    search: async () => {
      const provider = Object.assign(new Error("Synthetic upstream failure"), {
        status: 503,
      });
      provider.stack =
        "Error: Synthetic upstream failure\n    at provider (synthetic-provider.ts:12:3)";
      throw new Error(
        "AI Gateway request failed (model: synthetic-model, provider: synthetic-provider, route: openai-responses, feature: mail-classification, operation: classify): Synthetic upstream failure",
        { cause: provider },
      );
    },
  });
  return { vendor, runShortcode: started.runShortcode };
}

/** A synthetic Run whose progress changes after the browser has opened it. */
export async function seedLiveVendorMailSearchRun(page: Page, name: string) {
  const db = getFixtureDb();
  const userId = await fixtureUserId(page);
  await ensureMemberParty(page, name);
  const vendor = await insertWithShortcode(db, "vendor", {
    name,
    website: "https://example.test",
  });
  const started = await startVendorMailSearchJob(
    db,
    { vendorId: vendor.shortcode },
    buildActorContext(userId),
    { publish: async () => ({ transport: "queue", count: 1 }) },
  );
  const [saved] = await getDb(db)
    .select({ id: schema.run.id })
    .from(schema.run)
    .where(eq(schema.run.shortcode, started.runShortcode));
  if (!saved) throw new Error("Synthetic Run was not saved");
  return {
    runShortcode: started.runShortcode,
    async ageQueue() {
      const old = new Date(Date.now() - 4 * 60_000);
      await getDb(db)
        .update(schema.run)
        .set({ updatedAt: old })
        .where(eq(schema.run.id, saved.id));
      await getDb(db)
        .update(schema.runProgress)
        .set({ createdAt: old })
        .where(eq(schema.runProgress.runId, saved.id));
    },
    async advance() {
      await getDb(db).transaction(async (tx) => {
        await tx
          .update(schema.run)
          .set({
            progress: {
              phase: "running",
              pageToken: null,
              nextPageToken: null,
              pagesScanned: 0,
              searched: 6,
              reviewable: 0,
            },
            skipped: 2,
          })
          .where(eq(schema.run.id, saved.id));
        await tx.insert(schema.runProgress).values({
          runId: saved.id,
          eventId: crypto.randomUUID(),
          phase: "gmail_fetch",
          detail: "Checked 4 of 6 messages",
        });
      });
    },
    async complete() {
      await getDb(db).transaction(async (tx) => {
        await tx
          .update(schema.run)
          .set({
            status: "completed",
            progress: {
              phase: "completed",
              pageToken: null,
              nextPageToken: null,
              pagesScanned: 1,
              searched: 6,
              reviewable: 1,
            },
            skipped: 2,
          })
          .where(eq(schema.run.id, saved.id));
        await tx.insert(schema.runProgress).values({
          runId: saved.id,
          eventId: crypto.randomUUID(),
          phase: "completed",
          detail:
            "Checked 6 messages; 2 already saved; 1 order email to review",
        });
      });
    },
  };
}

/** A real two-page job execution with Gmail replaced at its external seam. */
export async function seedPagedVendorMailSearchRun(page: Page, name: string) {
  const db = getFixtureDb();
  const userId = await fixtureUserId(page);
  await ensureMemberParty(page, name);
  const vendor = await insertWithShortcode(db, "vendor", {
    name,
    website: "https://example.test",
  });
  const publish = async () => ({ transport: "queue" as const, count: 1 });
  const started = await startVendorMailSearchJob(
    db,
    { vendorId: vendor.shortcode },
    buildActorContext(userId),
    { publish },
  );
  const [saved] = await getDb(db)
    .select({ id: schema.run.id })
    .from(schema.run)
    .where(eq(schema.run.shortcode, started.runShortcode));
  if (!saved) throw new Error("Synthetic Run was not saved");
  return {
    runShortcode: started.runShortcode,
    firstPage: () =>
      runVendorMailSearchJob(db, saved.id, {
        publish,
        search: async () => ({
          searched: 10,
          skipped: 6,
          reviewable: 1,
          after: started.after,
          nextPageToken: "synthetic-next-page",
        }),
      }),
    lastPage: () =>
      runVendorMailSearchJob(db, saved.id, {
        page: 1,
        publish,
        search: async (_db, input) => {
          if (input.pageToken !== "synthetic-next-page")
            throw new Error("The Gmail checkpoint was not used");
          return {
            searched: 3,
            skipped: 2,
            reviewable: 1,
            after: started.after,
            nextPageToken: null,
          };
        },
      }),
  };
}

/** Saved itemized confirmation without a Purchase or browser account. */
export async function seedUnimportedOrderMail(page: Page, name: string) {
  const db = getFixtureDb();
  const member = await ensureMemberParty(page, name);
  const vendor = await insertWithShortcode(db, "vendor", { name });
  const checksum = "a".repeat(64);
  const [mail] = await getDb(db)
    .insert(schema.orderMail)
    .values({
      ledgerPartyId: member.id,
      vendorId: vendor.id,
      messageId: `synthetic-confirmation-${crypto.randomUUID()}`,
      sender: "orders@example.test",
      subject: "Synthetic itemized confirmation",
      receivedAt: new Date("2026-09-10T15:00:00Z"),
      rawChecksum: checksum,
      content: {
        snippet: null,
        bodyHtml: null,
        bodyText:
          "Order SYN-CONFIRM-1. Herb packet, SKU HERB-1, qty 1, $5.00. Grand total $5.00 USD.",
      },
    })
    .returning();
  if (!mail) throw new Error("Synthetic confirmation was not saved");
  const [event] = await getDb(db)
    .insert(schema.orderMailEvent)
    .values({
      orderMailId: mail.id,
      event: "placed",
      orderId: "SYN-CONFIRM-1",
      amount: 5,
      currency: "USD",
      sourceKey: `synthetic:${mail.id}`,
    })
    .returning();
  if (!event) throw new Error("Synthetic event was not saved");
  return { vendor, eventId: event.id, checksum };
}

import { orderMailImportRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import {
  importSourceClaim,
  importSourceOrder,
  mailboxMessage,
  orderMail,
  orderMailEvent,
  purchasePaymentEvidence,
  run,
} from "~/server/db/schema";
import { loadImportSourceFamilyOrders } from "~/server/purchase-import/source-claim-family";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import {
  openMainCutover,
  saveTables,
} from "./purchase-research-cutover.fixtures";

// Legacy per-order keys must become one source identity without repointing
// order/payment ownership; missing frozen authority must block admission/deletion.
// Every old textual identity remains readable, including when the canonical root
// is new. Existing aliases participate in whole-family ownership/collision checks.
describe("historical mail source identity migration", () => {
  const ctx = withTestDb();
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0)) await close();
  });
  async function fixture(count: number, proven = true) {
    const db = getDb(ctx.db);
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic source history member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic source history vendor",
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "account_sync",
      trigger: "manual",
      status: "completed",
    });
    const checksum = await sha256Hex("Synthetic immutable original mail bytes");
    const [mail] = await db
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        mailboxId: `legacy:${party.id}`,
        messageId: "synthetic-historical-orders",
        rawChecksum: checksum,
        sender: "orders@example.test",
        subject: "Synthetic historical receipt",
        receivedAt: new Date("2025-01-01T12:00:00Z"),
        content: {
          snippet: null,
          bodyHtml: null,
          bodyText: "Synthetic immutable original mail bytes",
        },
      })
      .returning();
    if (!mail) throw new Error("Synthetic original missing");
    const orders = [];
    for (let index = 0; index < count; index++) {
      const orderId = `SYNTHETIC-HISTORY-${index}`;
      const purchase = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        orderId,
        date: "2025-01-01",
      });
      const [event] = await db
        .insert(orderMailEvent)
        .values({
          orderMailId: mail.id,
          event: "placed",
          orderId,
          sourceKey: `synthetic-event-${index}`,
          payload: {},
        })
        .returning();
      if (!event) throw new Error("Synthetic event missing");
      orders.push({
        eventId: event.id,
        evidenceChecksum: proven ? checksum : "unproved-checksum",
        orderId,
      });
      const [claim] = await db
        .insert(importSourceClaim)
        .values({
          ledgerPartyId: party.id,
          kind: "mail_message",
          externalKey: `gmail:${mail.messageId}:order:${orderId}`,
          checksum,
          firstRunId: runId,
          lastRunId: runId,
        })
        .returning();
      if (!claim) throw new Error("Synthetic claim missing");
      await db.insert(importSourceOrder).values({
        id: claim.id,
        sourceClaimId: claim.id,
        orderKey: `${vendor.id}/order/${orderId}`,
        purchaseId: purchase.id,
        checksum,
        outputFingerprint: `synthetic-output-${index}`,
        createdAt: claim.createdAt,
        updatedAt: claim.updatedAt,
      });
      await db.insert(purchasePaymentEvidence).values({
        sourceClaimId: claim.id,
        purchaseId: purchase.id,
        amount: 10 + index,
        evidenceIndex: 0,
      });
    }
    await db
      .update(run)
      .set({
        ledgerPartyId: party.id,
        input: orderMailImportRunInput.parse({
          kind: "order_mail_import",
          orders,
        }),
      })
      .where(eq(run.id, runId));
    return {
      db,
      party,
      mail,
      claims: await db.select().from(importSourceClaim),
      associations: await db.select().from(importSourceOrder),
      payments: await db.select().from(purchasePaymentEvidence),
    };
  }
  async function transform(f: Awaited<ReturnType<typeof fixture>>) {
    const associations = await f.db.select().from(importSourceOrder);
    const saved = await saveTables(ctx.db);
    const migrated = await openMainCutover(saved, (table) =>
      table.name === "ImportSourceClaim"
        ? table.rows.map((row) => {
            const association = associations.find(
              (order) => order.sourceClaimId === row.id,
            );
            return {
              ...row,
              purchaseId: association?.purchaseId ?? null,
              outputFingerprint:
                association?.outputFingerprint ?? "synthetic-source-output",
            };
          })
        : table.rows,
    );
    cleanups.push(migrated.close);
    f.db = getDb(migrated.database);
    return migrated.database;
  }
  it.each([1, 2])(
    "converts %i proven per-order claims and preserves their entire incoming graph",
    async (count) => {
      const f = await fixture(count);
      await transform(f);
      const claims = await f.db.select().from(importSourceClaim);
      const roots = claims.filter(
        (claim) =>
          claim.externalKey === `gmail:${f.mail.mailboxId}:${f.mail.messageId}`,
      );
      expect(roots).toHaveLength(1);
      const root = roots[0]!;
      expect(
        claims
          .filter((claim) => claim.id !== root.id)
          .map(({ id }) => id)
          .sort(),
      ).toEqual(f.claims.map(({ id }) => id).sort());
      for (const before of f.claims) {
        const current = claims.find((claim) => claim.id === before.id);
        expect(current).toMatchObject({
          ...before,
          canonicalClaimId: root.id,
        });
        const pointers = await f.db.execute(
          sql`SELECT "canonicalClaimId" FROM "ImportSourceClaim" WHERE id = ${before.id}`,
        );
        expect(pointers.rows[0]?.canonicalClaimId).toBe(root.id);
      }
      expect(await f.db.select().from(importSourceOrder)).toEqual(
        f.associations,
      );
      expect(await f.db.select().from(purchasePaymentEvidence)).toEqual(
        f.payments,
      );
      expect(await f.db.select().from(mailboxMessage)).toEqual([]);
      expect(await f.db.select().from(orderMail)).toEqual([f.mail]);
    },
  );
  it("retains unproved source ownership and records an explicit blocked original", async () => {
    const f = await fixture(2, false);
    await transform(f);
    expect(await f.db.select().from(importSourceClaim)).toEqual(f.claims);
    expect(await f.db.select().from(importSourceOrder)).toEqual(f.associations);
    expect(await f.db.select().from(purchasePaymentEvidence)).toEqual(
      f.payments,
    );
    expect(await f.db.select().from(mailboxMessage)).toMatchObject([
      {
        ledgerPartyId: f.party.id,
        mailboxId: f.mail.mailboxId,
        messageId: f.mail.messageId,
        orderMailId: f.mail.id,
        checksum: f.mail.rawChecksum,
        classification: "related",
        classificationVersion: "legacy-source-identity-unresolved/v1",
        status: "blocked",
      },
    ]);
    expect(await f.db.select().from(orderMail)).toEqual([f.mail]);
  });
  it("retains every historical source lookup after creating a canonical identity", async () => {
    const f = await fixture(2);
    await transform(f);
    const history = await loadImportSourceFamilyOrders(f.db, {
      ledgerPartyId: f.party.id,
      externalKeys: f.claims.map((claim) => claim.externalKey),
    });
    expect(history.map(({ association }) => association.id).sort()).toEqual(
      f.associations.map((association) => association.id).sort(),
    );
    expect(history.map(({ claim }) => claim.externalKey).sort()).toEqual(
      f.claims.map((claim) => claim.externalKey).sort(),
    );
  });
  it("retains the entire original graph when the existing canonical source has a duplicate order", async () => {
    const f = await fixture(1);
    const owner = f.claims[0]!;
    const [root] = await f.db
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: f.party.id,
        kind: owner.kind,
        externalKey: `gmail:${f.mail.mailboxId}:${f.mail.messageId}`,
        checksum: owner.checksum,
        firstRunId: owner.firstRunId,
        lastRunId: owner.lastRunId,
      })
      .returning();
    if (!root) throw new Error("Synthetic existing root missing");
    const association = f.associations[0]!;
    await f.db.insert(importSourceOrder).values({
      id: root.id,
      sourceClaimId: root.id,
      orderKey: association.orderKey,
      purchaseId: association.purchaseId,
      checksum: association.checksum,
      outputFingerprint: association.outputFingerprint,
      createdAt: root.createdAt,
      updatedAt: root.updatedAt,
    });
    const before = {
      claims: await f.db.select().from(importSourceClaim),
      associations: await f.db.select().from(importSourceOrder),
      payments: await f.db.select().from(purchasePaymentEvidence),
    };
    await transform(f);
    expect(await f.db.select().from(importSourceClaim)).toEqual(before.claims);
    expect(await f.db.select().from(importSourceOrder)).toEqual(
      before.associations,
    );
    expect(await f.db.select().from(purchasePaymentEvidence)).toEqual(
      before.payments,
    );
    expect(await f.db.select().from(orderMail)).toEqual([f.mail]);
    expect(await f.db.select().from(mailboxMessage)).toMatchObject([
      { orderMailId: f.mail.id, status: "blocked" },
    ]);
  });
});

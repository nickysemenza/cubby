import { testUserId } from "@cubby/schemas/testing";
import { and, eq, isNull } from "drizzle-orm";
import type { Pool } from "pg";

import { authorizePurchaseAgent } from "~/server/purchase-import/purchase-agent-workerd.fixtures";
import { ledgerParty, orderMail, orderMailEvent } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { buildScenarioDatabase } from "./context";
import { IMPORT_AGENT_ORDER } from "./import-agent-order";
import { seedSimulatorPhotoActor } from "./simulator";

/**
 * One saved, itemized order confirmation the member can import from the
 * vendor page, plus the member's Purchase Agent grant that MCP delegation
 * requires. Everything else (the run, extraction, the Purchase) is produced
 * live by the journey.
 */
export async function seedImportAgentScenario(pool: Pool, userId: string) {
  await seedSimulatorPhotoActor(pool, userId);
  const db = buildScenarioDatabase(pool);
  const [member] = await getDb(db)
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.userId, testUserId(userId)),
        eq(ledgerParty.kind, "member"),
        isNull(ledgerParty.deletedAt),
      ),
    )
    .limit(1);
  if (!member) throw new Error("Synthetic member party was not seeded");
  const vendor = await insertWithShortcode(db, "vendor", {
    name: IMPORT_AGENT_ORDER.vendor,
  });
  const [mail] = await getDb(db)
    .insert(orderMail)
    .values({
      ledgerPartyId: member.id,
      vendorId: vendor.id,
      messageId: `synthetic-live-confirmation-${crypto.randomUUID()}`,
      sender: "orders@example.test",
      subject: "Synthetic itemized confirmation",
      receivedAt: new Date("2026-09-10T15:00:00Z"),
      rawChecksum: "b".repeat(64),
      content: {
        snippet: null,
        bodyHtml: null,
        bodyText: `Order ${IMPORT_AGENT_ORDER.orderId}. ${IMPORT_AGENT_ORDER.item}, SKU HERB-1, qty 1, $5.00. Grand total $5.00 USD.`,
      },
    })
    .returning();
  if (!mail) throw new Error("Synthetic confirmation was not saved");
  await getDb(db)
    .insert(orderMailEvent)
    .values({
      orderMailId: mail.id,
      event: "placed",
      orderId: IMPORT_AGENT_ORDER.orderId,
      amount: 5,
      currency: "USD",
      sourceKey: `synthetic:${mail.id}`,
    });
  await authorizePurchaseAgent(db, userId);
  return { vendorId: vendor.id, vendorShortcode: vendor.shortcode };
}

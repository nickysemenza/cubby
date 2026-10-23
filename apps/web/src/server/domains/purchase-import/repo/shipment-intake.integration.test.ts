import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { shipmentEvidence } from "@cubby/schemas/shipment-evidence";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  email,
  shipment,
  shipmentSourceCapture,
  expense,
  inventoryEntry,
} from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { recordShipmentEvidence } from "~/server/domains/shipment/repo/evidence";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  mailSource,
  memberImportWorld,
  retainedMailFixture,
} from "../operations/order-import.fixtures";
import { productionOrderMailAttachmentStorage } from "./gmail/attachment-storage";
import { clearUnrelatedOriginal } from "./gmail/persistence";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "./mail-source-identity";
import { recordImportedShipmentEvidence } from "./shipment-intake";

// A historical reconciliation may have no Run. Its source must still resolve
// to the verified public Email rather than an OrderMail UUID or a made-up Run.
describe("imported shipment source identity", () => {
  const ctx = withTestDb();
  it("protects an unmatched Shipment's Email original from unrelated disposal", async () => {
    const { party } = await memberImportWorld(ctx.db, ctx.actor);
    const original = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "synthetic-unmatched-parcel",
      checksum: "d".repeat(64),
    });
    const [message] = await getDb(ctx.db)
      .select()
      .from(email)
      .where(eq(email.orderMailId, original.id));
    if (!message) throw new Error("Synthetic Email missing");
    await recordShipmentEvidence(
      ctx.db,
      {
        source: {
          kind: "email",
          emailId: parseShortcodeFor("email", message.shortcode),
          checksum: original.rawChecksum,
        },
        purchaseId: null,
        shipments: [
          shipmentEvidence.parse({
            shipmentId: null,
            sourceShipmentKey: "parcel-1",
            distinctPackageEvidence: null,
            carrierId: null,
            carrierName: null,
            trackingNumber: "SYN-UNMATCHED-101",
            extraTrackingNumbers: [],
            purpose: "unknown",
            observations: [
              {
                sourceEventKey: null,
                kind: "in_transit",
                time: { kind: "date", value: "2026-06-03" },
                rawStatus: "Your package is in transit",
                location: null,
                carrierId: null,
                carrierName: null,
                trackingNumber: "SYN-UNMATCHED-101",
              },
            ],
          }),
        ],
      },
      ctx.actor,
    );
    expect(
      await clearUnrelatedOriginal(
        ctx.db,
        {
          ledgerPartyId: party.id,
          mailboxId: original.mailboxId,
          messageId: original.messageId,
        },
        productionOrderMailAttachmentStorage,
      ),
    ).toEqual({ orderMailId: original.id, checksum: original.rawChecksum });
    const [retained] = await readRetainedMail(ctx.db, {
      ledgerPartyIds: [party.id],
      orderMailIds: [original.id],
    });
    expect(retained?.content).toEqual(original.content);
    expect(
      (await getDb(ctx.db).select().from(shipment))[0]?.purchaseId,
    ).toBeNull();
  });

  it.each([false, true])(
    "records verified retained mail with a Run=%s",
    async (withRun) => {
      const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor);
      const target = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        orderId: "SYN-SOURCE-101",
      });
      const original = await retainedMailFixture(ctx.db, {
        ledgerPartyId: party.id,
        messageId: "synthetic-shipment-source",
        checksum: "a".repeat(64),
      });
      const runId = withRun
        ? await ensureRun(ctx.db, ctx.actor, {
            purpose: "file_import",
            status: "running",
            trigger: "manual",
          })
        : null;
      const [message] = await getDb(ctx.db)
        .select()
        .from(email)
        .where(eq(email.orderMailId, original.id));
      if (!message) throw new Error("Synthetic Email missing");
      const packet = shipmentEvidence.parse({
        shipmentId: null,
        sourceShipmentKey: "parcel-1",
        distinctPackageEvidence:
          "A separate parcel containing the replacement filter",
        carrierId: null,
        carrierName: null,
        trackingNumber: null,
        extraTrackingNumbers: [],
        purpose: "replacement",
        observations: [
          {
            sourceEventKey: null,
            kind: "label_created",
            time: { kind: "date", value: "2026-06-03" },
            rawStatus: "Replacement package label created",
            location: null,
            carrierId: null,
            carrierName: null,
            trackingNumber: null,
          },
        ],
      });
      const input = {
        source: mailSource(original),
        runId,
        ledgerPartyId: party.id,
        purchaseId: target.id,
        shipments: [packet],
      };
      const record = () =>
        withTransactionDatabase(ctx.db, (db) =>
          recordImportedShipmentEvidence(db, input, ctx.actor),
        );
      await record();
      await record();
      expect(await getDb(ctx.db).select().from(shipment)).toHaveLength(1);
      const [capture] = await getDb(ctx.db)
        .select()
        .from(shipmentSourceCapture);
      expect(capture?.source).toEqual({
        kind: "email",
        emailId: message.shortcode,
        checksum: original.rawChecksum,
      });
      expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
      await getDb(ctx.db)
        .update(email)
        .set({ classificationVersion: HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION })
        .where(eq(email.id, message.id));
      await expect(record()).rejects.toThrow(
        "Historical mail source ownership is unresolved",
      );
      await expect(
        withTransactionDatabase(ctx.db, (db) =>
          recordImportedShipmentEvidence(
            db,
            { ...input, source: { ...input.source, checksum: "b".repeat(64) } },
            ctx.actor,
          ),
        ),
      ).rejects.toThrow("unchanged");
      expect(await getDb(ctx.db).select().from(shipment)).toHaveLength(1);
    },
  );
});

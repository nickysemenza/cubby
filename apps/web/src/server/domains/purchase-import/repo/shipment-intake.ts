import type { ActorContext } from "@cubby/schemas/context";
import {
  parseShortcodeFor,
  type PurchaseId,
  type RunId,
  type LedgerPartyId,
} from "@cubby/schemas/identifiers";
import type { ImportWriterInput } from "@cubby/schemas/purchase-import";
import type { RetainedShipmentEvidence } from "@cubby/schemas/shipment-evidence";
import { shipmentPurpose } from "@cubby/schemas/shipment-fields";
import { and, eq, sql } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { email, purchase } from "~/server/db/schema";
import {
  loadImportScope,
  readUnchangedMailSource,
  retainedMailSource,
} from "~/server/domains/purchase-import/repo/import-scope";
import { recordRetainedShipmentEvidence } from "~/server/domains/shipment/repo/evidence";
import { createAppError } from "~/server/errors/app-error";

/** The order writer already owns the transaction; verify the original again inside it. */
export async function recordImportedShipmentEvidence(
  db: Database,
  input: {
    source: ImportWriterInput["source"];
    runId: RunId | null;
    ledgerPartyId: LedgerPartyId;
    purchaseId: PurchaseId;
    shipments: readonly RetainedShipmentEvidence[];
  },
  actor: ActorContext,
) {
  if (!input.shipments.length) return;
  // Browser captures use shipments.record with their literal retained content.
  // An order extraction alone cannot supply a tracking-page source capture.
  if (
    input.source.kind !== "mail_message" &&
    input.source.kind !== "mail_attachment"
  )
    return;
  const original = input.runId
    ? await retainedMailSource(
        db,
        await loadImportScope(db, input.runId, actor),
        input.source,
        input.source.checksum,
      )
    : await readUnchangedMailSource(
        db,
        { ledgerPartyId: input.ledgerPartyId, purpose: null },
        input.source,
        input.source.checksum,
      );
  if (!original)
    throw createAppError(
      "MAIL_EVIDENCE_STALE",
      "Shipment evidence requires a retained Email original.",
    );
  // The evidence writer verifies source identity once it holds the original.
  const [message] = await getDb(db)
    .select({
      shortcode: email.shortcode,
      purchaseShortcode: sql<
        string | null
      >`(SELECT ${purchase.shortcode} FROM ${purchase} WHERE ${purchase.id} = ${input.purchaseId})`,
    })
    .from(email)
    .where(
      and(
        eq(email.orderMailId, original.id),
        eq(email.ledgerPartyId, original.ledgerPartyId),
        eq(email.provider, "gmail"),
        eq(email.mailboxId, original.mailboxId),
        eq(email.messageId, original.messageId),
        notDeleted(email),
      ),
    )
    .limit(1);
  if (!message)
    throw createAppError(
      "MAIL_EVIDENCE_STALE",
      "The Shipment Email is no longer available.",
    );
  if (!message.purchaseShortcode)
    throw createAppError(
      "MAIL_EVIDENCE_STALE",
      "Shipment Email or Purchase is no longer available.",
    );
  await recordRetainedShipmentEvidence(
    db,
    {
      source: {
        kind: "email",
        emailId: parseShortcodeFor("email", message.shortcode),
        checksum: original.rawChecksum,
      },
      purchaseId: parseShortcodeFor("purchase", message.purchaseShortcode),
      shipments: input.shipments.map((packet) => {
        const purpose = shipmentPurpose.safeParse(packet.purpose);
        return {
          ...packet,
          purpose: purpose.success ? purpose.data : "unknown",
          observations: packet.observations.map((observation) => ({
            ...observation,
            // Only a date supplied here has known fallback provenance. A retained
            // date without provenance must not become a claimed stated event.
            ...(observation.time.kind === "unknown" && original.receivedAt
              ? { timeBasis: observation.timeBasis ?? "notification_received" }
              : {}),
            time:
              observation.time.kind === "unknown" && original.receivedAt
                ? {
                    kind: "date",
                    value: householdLocalDate(original.receivedAt),
                  }
                : observation.time,
          })),
        };
      }),
    },
    actor,
  );
}

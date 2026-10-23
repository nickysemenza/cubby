import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  parseEntityId,
  parseShortcodeFor,
  type PurchaseId,
  type RunId,
  type LedgerPartyId,
} from "@cubby/schemas/identifiers";
import type { ImportWriterInput } from "@cubby/schemas/purchase-import";
import type { ShipmentEvidence } from "@cubby/schemas/shipment-evidence";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { email } from "~/server/db/schema";
import { recordShipmentEvidence } from "~/server/domains/shipment/repo/evidence";
import { createAppError } from "~/server/errors/app-error";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  loadImportScope,
  readUnchangedMailSource,
  retainedMailSource,
} from "./import-scope";
import { assertMailSourceIdentityReady } from "./mail-source-identity";

/** The order writer already owns the transaction; verify the original again inside it. */
export async function recordImportedShipmentEvidence(
  db: Database,
  input: {
    source: ImportWriterInput["source"];
    runId: RunId | null;
    ledgerPartyId: LedgerPartyId;
    purchaseId: PurchaseId;
    shipments: readonly ShipmentEvidence[];
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
  await assertMailSourceIdentityReady(getDb(db), original);
  const [message] = await getDb(db)
    .select({ id: email.id })
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
  const emailId = parseEntityId("email", message.id);
  const codes = await lookupShortcodes(db, [
    { entity: "purchase", id: input.purchaseId },
    { entity: "email", id: emailId },
  ]);
  const emailCode = codes.get(entityRefKey("email", emailId));
  const purchaseCode = codes.get(entityRefKey("purchase", input.purchaseId));
  if (!emailCode || !purchaseCode)
    throw createAppError(
      "MAIL_EVIDENCE_STALE",
      "Shipment Email or Purchase is no longer available.",
    );
  await recordShipmentEvidence(
    db,
    {
      source: {
        kind: "email",
        emailId: parseShortcodeFor("email", emailCode),
        checksum: original.rawChecksum,
      },
      purchaseId: parseShortcodeFor("purchase", purchaseCode),
      shipments: [...input.shipments],
    },
    actor,
  );
}

import type { ActorContext } from "@cubby/schemas/context";
import type { EmailId } from "@cubby/schemas/identifiers";
import type { RecordShipmentEvidenceInput } from "@cubby/schemas/shipment-evidence";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { shipmentSourceCapture, email, ledgerParty } from "~/server/db/schema";
import {
  readRetainedMail,
  type RetainedMail,
} from "~/server/domains/mail/repo/retained-mail";
import { loadImportScope } from "~/server/domains/purchase-import/repo/import-scope";
import { assertMailRunMembership } from "~/server/domains/purchase-import/repo/mail-run-membership";
import { assertMailSourceIdentityReady } from "~/server/domains/purchase-import/repo/mail-source-identity";
import { runPurposePolicy } from "~/server/domains/run/repo/purpose-policy";
import { constraintViolation } from "~/server/errors/app-error";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

const canonical = (value: unknown) => canonicalJson(jsonSnapshot.parse(value));
export async function loadSourceCapture(
  db: Database,
  input: Pick<RecordShipmentEvidenceInput, "source">,
  actor: ActorContext,
) {
  const source = input.source;
  let emailId: EmailId | null = null;
  let ownerId: string | null = null;
  let sourceKey: string;
  let checksum: string;
  let originalContent: RetainedMail["content"] | null = null;
  let notificationDate: string | null = null;
  if (source.kind === "email") {
    emailId = await resolveOrThrow(db, "email", source.emailId);
    const [message] = await getDb(db)
      .select()
      .from(email)
      .where(and(eq(email.id, emailId), notDeleted(email)))
      .for("share");
    if (!message?.orderMailId)
      return constraintViolation(
        "Shipment Email requires a retained original.",
      );
    const parties = await getDb(db)
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(
        and(
          eq(ledgerParty.userId, actor.userId),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      );
    const [original] = await readRetainedMail(
      db,
      {
        ledgerPartyIds: parties.map((row) => row.id),
        orderMailIds: [message.orderMailId],
      },
      "share",
    );
    if (!original || original.rawChecksum !== source.checksum)
      return constraintViolation(
        "Shipment Email is foreign, missing or changed; read its original again.",
      );
    await assertMailSourceIdentityReady(getDb(db), original);
    if (actor.runId) {
      const scope = await loadImportScope(db, actor.runId, actor);
      if (
        scope.ledgerPartyId !== original.ledgerPartyId ||
        scope.status !== "running"
      )
        return constraintViolation(
          "The active import Run does not own this Email or is not running.",
        );
      const mailSources = runPurposePolicy(scope.purpose).mailSources;
      if (mailSources === "admitted")
        await assertMailRunMembership(getDb(db), actor.runId, original.id);
      else if (mailSources !== "owner")
        return constraintViolation("This Run cannot record shipment evidence.");
    }
    ownerId = original.ledgerPartyId;
    originalContent = original.content;
    notificationDate = original.receivedAt
      ? householdLocalDate(original.receivedAt)
      : null;
    sourceKey = `email:${emailId}`;
    checksum = source.checksum;
  } else {
    if (actor.runId)
      return constraintViolation(
        "Unattended mail processing cannot submit interactive shipment captures.",
      );
    if (new Date(source.capturedAt).getTime() > Date.now() + 300000)
      return constraintViolation(
        "Tracking capture time cannot be in the future.",
      );
    sourceKey =
      source.kind === "tracking_page"
        ? `tracking_page:${actor.userId}:${source.url}:${source.externalKey}`
        : `sms_export:${actor.userId}:${source.externalKey}`;
    checksum = await sha256Hex(
      source.kind === "sms_export"
        ? canonical({
            sender: source.sender,
            sentAt: source.sentAt,
            content: source.content,
          })
        : source.content,
    );
    if (source.kind === "sms_export") {
      notificationDate =
        source.sentAt.kind === "instant"
          ? householdLocalDate(new Date(source.sentAt.value))
          : source.sentAt.kind === "date" || source.sentAt.kind === "local"
            ? source.sentAt.value.slice(0, 10)
            : null;
      const prior = await getDb(db)
        .select({ checksum: shipmentSourceCapture.checksum })
        .from(shipmentSourceCapture)
        .where(eq(shipmentSourceCapture.sourceKey, sourceKey))
        .limit(1);
      if (prior[0] && prior[0].checksum !== checksum)
        return constraintViolation(
          "The exported SMS source changed; review its original instead of replacing it.",
        );
    }
  }
  return {
    sourceKey,
    checksum,
    source,
    originalContent,
    emailId,
    actorUserId: actor.userId,
    ownerId,
    notificationDate,
  };
}

type LoadedSource = Awaited<ReturnType<typeof loadSourceCapture>>;
export function planSourceCapture(loaded: LoadedSource) {
  return {
    sourceKey: loaded.sourceKey,
    checksum: loaded.checksum,
    source: loaded.source,
    originalContent: loaded.originalContent,
    emailId: loaded.emailId,
    actorUserId: loaded.actorUserId,
  };
}
export async function applySourceCapture(
  db: Database,
  plan: ReturnType<typeof planSourceCapture>,
) {
  const [capture] = await getDb(db)
    .insert(shipmentSourceCapture)
    .values(plan)
    .onConflictDoUpdate({
      target: [shipmentSourceCapture.sourceKey, shipmentSourceCapture.checksum],
      set: { sourceKey: plan.sourceKey },
    })
    .returning();
  if (!capture) throw new Error("Shipment source capture was not retained.");
  return capture;
}

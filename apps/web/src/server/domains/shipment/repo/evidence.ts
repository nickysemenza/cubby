import type { ActorContext } from "@cubby/schemas/context";
import type { EmailId } from "@cubby/schemas/identifiers";
import {
  parseEntityId,
  parseShortcodeFor,
  type PurchaseId,
  type ShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  recordShipmentEvidenceInput,
  associateShipmentInput,
  mergeShipmentInput,
  reassignShipmentEvidenceInput,
  editShipmentObservationInput,
  shipmentObservationInput,
  retainedShipmentEvidence,
  datedShipmentEventTime,
  type RecordShipmentEvidenceInput,
  type ShipmentEvidence,
  type ShipmentObservationInput,
} from "@cubby/schemas/shipment-evidence";
import {
  shipmentPurpose,
  SHIPMENT_IDENTITY_PERIOD_DAYS,
  type ShipmentExtraTrackingNumberRemovals,
  type ShipmentPurpose,
} from "@cubby/schemas/shipment-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
  withTransaction,
} from "~/server/db/helpers";
import {
  shipment,
  shipmentObservation,
  shipmentSourceCapture,
  shipmentSourcePackage,
  shipmentObservationCapture,
  email,
  ledgerParty,
  purchase,
  vendorAccount,
  vendor,
} from "~/server/db/schema";
import {
  readRetainedMail,
  type RetainedMail,
} from "~/server/domains/mail/repo/retained-mail";
import { loadImportScope } from "~/server/domains/purchase-import/repo/import-scope";
import { assertMailRunMembership } from "~/server/domains/purchase-import/repo/mail-run-membership";
import { assertMailSourceIdentityReady } from "~/server/domains/purchase-import/repo/mail-source-identity";
import { publishRunFinding } from "~/server/domains/purchase-import/repo/run-finding";
import {
  assessCarrierPacket,
  carrierCaptureEvidence,
  loadCarrierHistory,
  carrierClaimsConflict,
  resolveCarrierName,
  carrierFormatEvidence,
  deliveryFieldCodes,
  withoutDeliveryFieldCarrier,
} from "~/server/domains/shipment/repo/carrier-evidence";
import { resolveProductBrand } from "~/server/domains/vendor/repo/product-brand";
import { resolveEntityIdentity } from "~/server/entity-kernel/repo/entity-identity";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";
import { recordChange } from "~/server/generic/changes/repo/change";
import { finalizeMerge, mergeNotes } from "~/server/generic/merge/repo/core";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

import {
  deduplicateShipmentTrackingReferences,
  shipmentTrackingReferenceKey,
} from "./carrier-references";

const refuse = (message: string): never => {
  throw createAppError("CONSTRAINT_VIOLATION", message);
};
const canonical = (value: unknown) => canonicalJson(jsonSnapshot.parse(value));
const normalizeNumber = (value: string) =>
  value.replaceAll(/\s/g, "").toUpperCase();
// Re-extraction can respell one source's key. Only that same source may match it:
// generic labels such as an origin state recur across unrelated orders.
const sourcePackageSpelling = (key: string) =>
  key.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, "") || key;
const shipmentPurposesDisagree = (
  first: ShipmentPurpose,
  second: ShipmentPurpose,
) => first !== "unknown" && second !== "unknown" && first !== second;

const amazonLink = (href: string) => {
  const url = URL.canParse(href) ? new URL(href) : null;
  return url?.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    /^(?:www\.)?amazon\.com$/.test(url.hostname)
    ? url
    : null;
};

/** The one bounded vendor route known to name a parcel: Amazon's package tracker
 * identifies it by order, shipment and package index, directly or through its own
 * redirect. An Amazon shipment can span parcels, so the index is required.
 */
function vendorPackageLink(href: string) {
  const link = amazonLink(href);
  const redirect =
    link?.pathname === "/gp/r.html" ? link.searchParams.getAll("U") : [];
  const url = redirect[0] && !redirect[1] ? amazonLink(redirect[0]) : link;
  if (!url || !/^\/progress-tracker\/package(?:\/|$)/.test(url.pathname))
    return null;
  const [order, shipmentId, index] = [
    "orderId",
    "shipmentId",
    "packageIndex",
  ].map((name) => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 ? values[0] : undefined;
  });
  return order && shipmentId && index && /^\d+$/.test(index)
    ? { order, shipmentId, index }
    : null;
}

/** Parcels the retained original links that this source key names. The key is extractor
 * text and cannot prove anything alone: counters, labels and order ids can share its
 * spelling. Without a retained link (tracking pages, SMS) a package stays source-local.
 */
function retainedPackages(
  capture: Parameters<typeof carrierCaptureEvidence>[0],
  packageKey: string,
) {
  const tokens = packageKey.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const packages = new Map<
    string,
    NonNullable<ReturnType<typeof vendorPackageLink>>
  >();
  for (const { href } of carrierCaptureEvidence(capture).links) {
    const linked = vendorPackageLink(href);
    if (!linked) continue;
    const at = tokens.indexOf(linked.shipmentId.toLowerCase());
    // Index follows the shipment id, with or without one label: `id=X:index=0`.
    if (
      at >= 0 &&
      (tokens[at + 1] === linked.index || tokens[at + 2] === linked.index)
    )
      packages.set(canonical(linked), linked);
  }
  return packages;
}

/** The item list a notice states for its only parcel of this shipment, or null. Equal
 * lists never identify a parcel: two boxes can hold identical lists, and a source can
 * repeat its order's items. Amazon can also renumber one parcel between its notices, so
 * they only hold a packet for review rather than guess either way. A single line or a
 * grouped notice is too weak to raise that review.
 */
function retainedParcelItems(
  capture: Parameters<typeof carrierCaptureEvidence>[0],
  parcel: { order: string; shipmentId: string },
) {
  const { links, texts } = carrierCaptureEvidence(capture);
  const indexes = new Set(
    links.flatMap(({ href }) => {
      const linked = vendorPackageLink(href);
      return linked?.order === parcel.order &&
        linked.shipmentId === parcel.shipmentId
        ? [linked.index]
        : [];
    }),
  );
  if (indexes.size !== 1) return null;
  for (const text of texts) {
    const lines = [
      ...text.matchAll(
        /^[ \t]*\* +(.+?)[ \t]*$\s*^[ \t]*Quantity: *(\d+)[ \t]*$/gmu,
      ),
    ].map(([, name, quantity]) => ({
      name: name?.toLowerCase(),
      quantity,
    }));
    if (new Set(lines.map(({ name }) => name)).size >= 2)
      return canonical(
        [...lines].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
      );
  }
  return null;
}

// Pending preparations retain their literal provenance. This private Email ingress
// still requires dated observations and shares all source/identity/write enforcement.
const retainedRecordInput = z.strictObject({
  ...recordShipmentEvidenceInput.shape,
  source: recordShipmentEvidenceInput.shape.source.options[0],
  shipments: z
    .array(
      retainedShipmentEvidence.safeExtend({
        purpose: shipmentPurpose,
        observations: z
          .array(
            shipmentObservationInput
              .extend({ time: datedShipmentEventTime })
              .refine(
                (event) =>
                  event.timeBasis !== "notification_received" ||
                  event.time.kind === "date",
                "Notification fallback uses its calendar date at date-only precision.",
              ),
          )
          .min(1)
          .max(500),
      }),
    )
    .min(1)
    .max(50),
});
type ShipmentWriterInput = Omit<RecordShipmentEvidenceInput, "shipments"> &
  Pick<z.infer<typeof retainedRecordInput>, "shipments">;

async function observationIdentity(
  observation: ShipmentObservationInput,
  occurrences: Map<string, number>,
) {
  const fingerprint = await sha256Hex(canonical(observation));
  const { timeBasis: _timeBasis, ...literalObservation } = observation;
  const literalFingerprint = await sha256Hex(canonical(literalObservation));
  const ordinal = occurrences.get(literalFingerprint) ?? 0;
  occurrences.set(literalFingerprint, ordinal + 1);
  return {
    fingerprint,
    literalFingerprint,
    occurrenceKey: observation.sourceEventKey
      ? `event:${observation.sourceEventKey}`
      : `content:${literalFingerprint}:${ordinal}`,
  };
}

// Without wording, carrier or place: what must agree for one source to restate an event.
const restatedEvent = (event: ShipmentObservationInput) =>
  canonical({
    kind: event.kind,
    time: event.time,
    forecast: event.timeBasis === "estimate",
    trackingNumber: normalizeNumber(event.trackingNumber ?? ""),
  });
const eventPlace = (event: ShipmentObservationInput) =>
  event.location?.trim().toLowerCase() ?? null;

/**
 * Occurrence identities for one packet, keeping stored keys and fingerprints. A keyless
 * identity hashes the submitted wording and carrier hints, so re-reading identical source
 * content under a new extraction looks like a new event. Only that same capture can revise
 * an occurrence, and only when exactly one unclaimed occurrence and one unmatched
 * observation restate each other, first apart from carrier hints and then apart from
 * wording. Anything else stays a separate event: same-day occurrences are never guessed.
 */
async function packetObservationIdentities(
  db: Database,
  captureId: string,
  observations: readonly ShipmentObservationInput[],
  history: readonly (typeof shipmentObservation.$inferSelect)[],
) {
  const occurrences = new Map<string, number>();
  const identified: (Awaited<ReturnType<typeof observationIdentity>> & {
    observation: ShipmentObservationInput;
    revisesFromSameCapture: boolean;
  })[] = [];
  for (const observation of observations)
    identified.push({
      observation,
      ...(await observationIdentity(observation, occurrences)),
      revisesFromSameCapture: false,
    });
  const known = new Set(history.map((version) => version.occurrenceKey));
  const claimed = new Set(
    identified
      .map(({ occurrenceKey }) => occurrenceKey)
      .filter((key) => known.has(key)),
  );
  const sourceVersions = history.filter(
    (version) => version.sourceEventKey === null && !version.memberReviewed,
  );
  const unmatched = () =>
    identified.filter(
      ({ observation, occurrenceKey }) =>
        observation.sourceEventKey === null && !claimed.has(occurrenceKey),
    );
  // An earlier correction already holds this wording under the original occurrence.
  for (const entry of unmatched()) {
    const revised = sourceVersions.find(
      (version) =>
        !claimed.has(version.occurrenceKey) &&
        (version.fingerprint === entry.fingerprint ||
          (version.event.timeBasis === undefined &&
            version.fingerprint === entry.literalFingerprint)),
    );
    if (!revised) continue;
    entry.occurrenceKey = revised.occurrenceKey;
    claimed.add(revised.occurrenceKey);
  }
  if (!sourceVersions.length || !unmatched().length) return identified;
  const supported = new Set(
    (
      await getDb(db)
        .select({ id: shipmentObservationCapture.observationId })
        .from(shipmentObservationCapture)
        .where(eq(shipmentObservationCapture.captureId, captureId))
    ).map(({ id }) => id),
  );
  for (const restated of [
    (event: ShipmentObservationInput) =>
      canonical([restatedEvent(event), eventPlace(event), event.rawStatus]),
    restatedEvent,
  ]) {
    const pending = unmatched();
    for (const entry of pending) {
      const key = restated(entry.observation);
      const open = new Map(
        sourceVersions
          .filter(
            (version) =>
              supported.has(version.id) &&
              !claimed.has(version.occurrenceKey) &&
              restated(version.event) === key,
          )
          .map((version) => [version.occurrenceKey, version.event]),
      );
      const [only, rival] = open.entries();
      if (
        !only ||
        rival ||
        pending.filter(
          (other) =>
            restated(other.observation) === key &&
            !claimed.has(other.occurrenceKey),
        ).length !== 1
      )
        continue;
      const [occurrenceKey, event] = only;
      const [stored, submitted] = [
        eventPlace(event),
        eventPlace(entry.observation),
      ];
      if (stored && submitted && stored !== submitted) continue;
      entry.occurrenceKey = occurrenceKey;
      entry.revisesFromSameCapture = true;
      claimed.add(occurrenceKey);
    }
  }
  return identified;
}

const identityWindowSchema = z.object({
  first: z.string().nullable(),
  last: z.string().nullable(),
});

async function identityCandidates(
  db: Database,
  references: readonly { number: string; carrier: string | null }[],
  observations: readonly ShipmentObservationInput[],
  notificationDate: string | null,
) {
  const dates = await getDb(db).execute(
    sql`SELECT
    min(shipment_event_day(e))::text AS first, max(shipment_event_day(e))::text AS last
    FROM jsonb_array_elements(${JSON.stringify(observations)}::jsonb) e`,
    "objects",
  );
  const observedWindow = identityWindowSchema.parse(dates[0]);
  const window = {
    first: observedWindow.first ?? notificationDate,
    last: observedWindow.last ?? notificationDate,
  };
  const result = await getDb(db).execute(
    // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- carrier is the existing identity JSON object's key, not a carrier-role value.
    sql`SELECT id, shortcode, purchase_id,
    first_day::text, last_day::text, carrier_conflict FROM shipment_identity_candidates(
    (SELECT coalesce(jsonb_agg(jsonb_build_object('trackingNumber', r->>'trackingNumber',
      'carrier', shipment_carrier_key(r->>'carrier'))), '[]'::jsonb)
     FROM jsonb_array_elements(${JSON.stringify(references.map((ref) => ({ trackingNumber: ref.number, carrier: ref.carrier })))}::jsonb) r),
    ${window.first}::date, ${window.last}::date)`,
    "objects",
  );
  return {
    window,
    candidates: z
      .array(
        z.object({
          id: z.uuid(),
          shortcode: z.string(),
          purchase_id: z.uuid().nullable(),
          first_day: z.string().nullable(),
          last_day: z.string().nullable(),
          carrier_conflict: z.boolean(),
        }),
      )
      .parse(result),
  };
}

const withinIdentityPeriod = (days: readonly (string | null)[]) => {
  const dates = days
    .filter((day) => day !== null)
    .map((day) => Date.parse(day));
  return (
    dates.length > 0 &&
    Math.max(...dates) - Math.min(...dates) <=
      SHIPMENT_IDENTITY_PERIOD_DAYS * 86400000
  );
};

/** The live Shipment another retained source links to the same parcel. Each candidate
 * must fit this packet before it counts: a parcel id reused in a separate period is no
 * rival. None fits: a separate Shipment. Several fit, or any fitting Shipment lists the
 * same items under another parcel number: "ambiguous", never a guess.
 */
async function retainedPackageShipment(
  db: Database,
  input: {
    capture: typeof shipmentSourceCapture.$inferSelect;
    ownerId: string | null;
    packageKey: string;
    purpose: ShipmentPurpose;
    purchaseId: Awaited<ReturnType<typeof purchaseReference>>;
    window: z.infer<typeof identityWindowSchema>;
  },
) {
  const packages = retainedPackages(input.capture, input.packageKey);
  if (!packages.size) return undefined;
  const spelling = sourcePackageSpelling(input.packageKey);
  const bound = await getDb(db)
    .select({
      id: shipment.id,
      shortcode: shipment.shortcode,
      purchaseId: shipment.purchaseId,
      purpose: shipment.purpose,
      packageKey: shipmentSourcePackage.packageKey,
      source: shipmentSourceCapture.source,
      originalContent: shipmentSourceCapture.originalContent,
    })
    .from(shipmentSourcePackage)
    .innerJoin(shipment, eq(shipment.id, shipmentSourcePackage.shipmentId))
    .innerJoin(
      shipmentSourceCapture,
      eq(shipmentSourceCapture.sourceKey, shipmentSourcePackage.sourceKey),
    )
    .where(
      and(
        notDeleted(shipment),
        ne(shipmentSourcePackage.sourceKey, input.capture.sourceKey),
        or(
          sql`lower(regexp_replace(${shipmentSourcePackage.packageKey}, '[^[:alnum:]]', '', 'g')) = ${spelling}`,
          ...[...packages.values()].map(
            ({ shipmentId }) =>
              sql`position(${shipmentId.toLowerCase()}::text in lower(${shipmentSourcePackage.packageKey})) > 0`,
          ),
        ),
      ),
    );
  const sameParcel = (row: (typeof bound)[number]) =>
    sourcePackageSpelling(row.packageKey) === spelling &&
    [...retainedPackages(row, row.packageKey).keys()].some((key) =>
      packages.has(key),
    );
  const listsSameItems = (row: (typeof bound)[number]) =>
    [...packages.values()].some((parcel) => {
      const items = retainedParcelItems(input.capture, parcel);
      return (
        items !== null &&
        [...retainedPackages(row, row.packageKey).values()].some(
          (other) =>
            other.order === parcel.order &&
            other.shipmentId === parcel.shipmentId &&
            retainedParcelItems(row, other) === items,
        )
      );
    });
  const proven = new Map(bound.filter(sameParcel).map((row) => [row.id, row]));
  const reviewCandidates = bound.filter(
    (row) => !proven.has(row.id) && listsSameItems(row),
  );
  const fits = async (candidate: (typeof bound)[number]) => {
    if (
      shipmentPurposesDisagree(input.purpose, candidate.purpose) ||
      (input.purchaseId &&
        candidate.purchaseId &&
        candidate.purchaseId !== input.purchaseId)
    )
      return false;
    const purchaseOwner = candidate.purchaseId
      ? await purchaseSourceOwner(db, candidate.purchaseId)
      : null;
    if (
      (candidate.purchaseId && !purchaseOwner) ||
      (purchaseOwner?.ownerId && purchaseOwner.ownerId !== input.ownerId) ||
      (await shipmentSourceOwners(db, candidate.id)).some(
        (ownerId) => ownerId !== input.ownerId,
      )
    )
      return false;
    const period = identityWindowSchema.parse(
      (
        await getDb(db).execute(
          sql`SELECT first_day::text AS first, last_day::text AS last FROM shipment_identity_window(${candidate.id}::uuid)`,
          "objects",
        )
      )[0],
    );
    return Boolean(
      period.first &&
      input.window.first &&
      withinIdentityPeriod([
        input.window.first,
        input.window.last,
        period.first,
        period.last,
      ]),
    );
  };
  for (const candidate of reviewCandidates)
    if (await fits(candidate)) return "ambiguous" as const;
  const fitting = [];
  for (const candidate of proven.values())
    if (await fits(candidate)) fitting.push(candidate);
  const [match, rival] = fitting;
  if (rival) return "ambiguous" as const;
  return match ? canonicalShipment(db, match.shortcode) : undefined;
}

// Intake and explicit corrections share this transaction lock: replay cannot race a package merge.
async function lockShipmentWrites(db: Database) {
  await getDb(db).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('shipment-evidence-intake', 0))`,
  );
}

export async function canonicalShipment(
  db: Database,
  code: string,
  followRedirect = false,
) {
  const identity = await resolveEntityIdentity(db, code);
  const id =
    identity.state === "live" && identity.kind === "shipment"
      ? identity.id
      : followRedirect &&
          identity.state === "redirected" &&
          identity.kind === "shipment" &&
          !identity.canonicalDeletedAt
        ? identity.canonicalId
        : null;
  if (!id)
    return refuse(
      "The Shipment is missing, deleted or merged; use its current SHIP reference for writes.",
    );
  const [row] = await getDb(db)
    .select()
    .from(shipment)
    .where(
      and(eq(shipment.id, parseEntityId("shipment", id)), notDeleted(shipment)),
    )
    .for("update")
    .limit(1);
  if (!row) return refuse("The Shipment is no longer available.");
  return row;
}

async function carrierReference(
  db: Database,
  code: ShipmentEvidence["carrierId"],
  name: string | null,
) {
  const identity = code ? await resolveEntityIdentity(db, code) : null;
  const carrierCode =
    identity?.state === "redirected" &&
    identity.kind === "vendor" &&
    !identity.canonicalDeletedAt
      ? parseShortcodeFor("vendor", identity.canonicalShortcode)
      : (code ?? (await resolveCarrierName(db, name))?.code ?? null);
  if (code && carrierCode && name?.trim()) {
    const [claimed] = await getDb(db)
      .select({ name: vendor.name, aliases: vendor.aliases })
      .from(vendor)
      .where(and(eq(vendor.shortcode, carrierCode), notDeleted(vendor)))
      .for("share");
    const literal = name.trim().toLowerCase();
    if (
      claimed &&
      ![claimed.name, ...claimed.aliases].some(
        (alias) => alias.trim().toLowerCase() === literal,
      )
    )
      return refuse(
        "Carrier reference and literal carrier name disagree; verify the Vendor identity or its alias.",
      );
  }
  return {
    code: carrierCode,
    id: carrierCode
      ? await withTransaction(db, (tx) => resolveProductBrand(tx, carrierCode))
      : null,
  };
}

async function purchaseReference(
  db: Database,
  code: RecordShipmentEvidenceInput["purchaseId"],
) {
  if (!code) return null;
  const id = await resolveOrThrow(db, "purchase", code);
  const [row] = await getDb(db)
    .select({ id: purchase.id })
    .from(purchase)
    .where(and(eq(purchase.id, id), notDeleted(purchase)))
    .for("share")
    .limit(1);
  if (!row)
    return refuse(
      "The Purchase changed during shipment intake; read it again.",
    );
  return row.id;
}

async function projectCarrierReferences(
  db: Database,
  input: {
    row: typeof shipment.$inferSelect;
    carrier: Awaited<ReturnType<typeof carrierReference>>;
    number: string | null;
    carrierName: string | null;
    extraTrackingNumbers: (typeof shipment.$inferSelect)["extraTrackingNumbers"];
    correctingCarrier: boolean;
  },
) {
  const { row, carrier, number, extraTrackingNumbers, correctingCarrier } =
    input;
  const database = getDb(db);
  const [previousCarrier] =
    correctingCarrier && row.carrierId
      ? await database
          .select({ shortcode: vendor.shortcode })
          .from(vendor)
          .where(eq(vendor.id, row.carrierId))
      : [];
  const refs = [
    ...row.extraTrackingNumbers.filter(
      (ref) =>
        !correctingCarrier ||
        !(
          ref.carrierId === previousCarrier?.shortcode &&
          normalizeNumber(ref.trackingNumber) === number
        ),
    ),
    ...extraTrackingNumbers,
  ];
  const adoptedCarrier = correctingCarrier
    ? carrier.id
    : !row.trackingNumber
      ? (carrier.id ?? row.carrierId)
      : (row.carrierId ??
        (normalizeNumber(row.trackingNumber) === number ? carrier.id : null));
  if (
    number &&
    row.trackingNumber &&
    (normalizeNumber(row.trackingNumber) !== number ||
      (adoptedCarrier && carrier.id && adoptedCarrier !== carrier.id))
  )
    refs.push({
      carrierId: carrier.code,
      carrierName: input.carrierName,
      trackingNumber: number,
    });
  const uniqueRefs = await deduplicateShipmentTrackingReferences(db, {
    trackingNumber: row.trackingNumber ?? number,
    carrierId: adoptedCarrier,
    extraTrackingNumbers: refs,
  });
  return {
    carrierId: adoptedCarrier,
    trackingNumber: row.trackingNumber ?? number,
    extraTrackingNumbers: uniqueRefs,
  };
}

async function sourceCapture(
  db: Database,
  input: Pick<ShipmentWriterInput, "source">,
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
      return refuse("Shipment Email requires a retained original.");
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
      return refuse(
        "Shipment Email is foreign, missing or changed; read its original again.",
      );
    await assertMailSourceIdentityReady(getDb(db), original);
    if (actor.runId) {
      const scope = await loadImportScope(db, actor.runId, actor);
      if (
        scope.ledgerPartyId !== original.ledgerPartyId ||
        scope.status !== "running"
      )
        return refuse(
          "The active import Run does not own this Email or is not running.",
        );
      if (scope.purpose === "mail_import")
        await assertMailRunMembership(getDb(db), actor.runId, original.id);
      else if (scope.purpose !== "file_import")
        return refuse("This Run cannot record shipment evidence.");
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
      return refuse(
        "Unattended mail processing cannot submit interactive shipment captures.",
      );
    if (new Date(source.capturedAt).getTime() > Date.now() + 300000)
      return refuse("Tracking capture time cannot be in the future.");
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
        return refuse(
          "The exported SMS source changed; review its original instead of replacing it.",
        );
    }
  }
  const [capture] = await getDb(db)
    .insert(shipmentSourceCapture)
    .values({
      sourceKey,
      checksum,
      source,
      originalContent,
      emailId,
      actorUserId: actor.userId,
    })
    .onConflictDoUpdate({
      target: [shipmentSourceCapture.sourceKey, shipmentSourceCapture.checksum],
      set: { sourceKey },
    })
    .returning();
  if (!capture) throw new Error("Shipment source capture was not retained.");
  return { capture, sourceKey, ownerId, notificationDate };
}

// Ownership is checked on the Purchase's purchasing account, never inferred from who paid.
async function purchaseSourceOwner(db: Database, id: PurchaseId) {
  const [row] = await getDb(db)
    .select({ ownerId: vendorAccount.ledgerPartyId })
    .from(purchase)
    .leftJoin(vendorAccount, eq(vendorAccount.id, purchase.vendorAccountId))
    .where(and(eq(purchase.id, id), notDeleted(purchase)))
    .for("share", { of: purchase });
  return row;
}

async function assertPurchaseSourceOwner(
  db: Database,
  id: PurchaseId | null,
  ownerId: string | null,
) {
  if (!id || !ownerId) return;
  const row = await purchaseSourceOwner(db, id);
  if (!row) return refuse("The Shipment's Purchase is no longer live.");
  if (row?.ownerId && row.ownerId !== ownerId)
    refuse("The shipment Email and Purchase belong to different members.");
}

async function shipmentSourceOwners(db: Database, shipmentId: string) {
  const sources = await getDb(db)
    .select({ ownerId: email.ledgerPartyId })
    .from(shipmentObservation)
    .innerJoin(
      shipmentSourceCapture,
      eq(shipmentSourceCapture.id, shipmentObservation.sourceCaptureId),
    )
    .innerJoin(email, eq(email.id, shipmentSourceCapture.emailId))
    .where(
      eq(shipmentObservation.shipmentId, parseEntityId("shipment", shipmentId)),
    );
  return [...new Set(sources.map((source) => source.ownerId))];
}

async function assertShipmentAssociation(
  db: Database,
  shipmentId: string,
  purchaseId: PurchaseId | null,
) {
  if (!purchaseId) return;
  for (const ownerId of await shipmentSourceOwners(db, shipmentId))
    await assertPurchaseSourceOwner(db, purchaseId, ownerId);
}

async function automaticPurchaseAssociation(
  db: Database,
  row: typeof shipment.$inferSelect,
  purchaseId: PurchaseId | null,
) {
  if (row.purchaseAssociationReviewed || row.purchaseId || !purchaseId)
    return row.purchaseId;
  await assertShipmentAssociation(db, row.id, purchaseId);
  return purchaseId;
}

export async function recordShipmentEvidence(
  db: Database,
  raw: RecordShipmentEvidenceInput,
  actor: ActorContext,
) {
  return writeShipmentEvidence(
    db,
    recordShipmentEvidenceInput.parse(raw),
    actor,
  );
}

/** Only retained order extraction ingestion uses this boundary; public records require provenance. */
export async function recordRetainedShipmentEvidence(
  db: Database,
  raw: z.input<typeof retainedRecordInput>,
  actor: ActorContext,
) {
  return writeShipmentEvidence(db, retainedRecordInput.parse(raw), actor);
}

async function writeShipmentEvidence(
  db: Database,
  input: ShipmentWriterInput,
  actor: ActorContext,
) {
  // oxlint-disable-next-line complexity -- Source ownership, package identity and reviewed revisions commit under one shipment lock.
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const database = getDb(tdb);
    const { capture, sourceKey, ownerId, notificationDate } =
      await sourceCapture(tdb, input, actor);
    for (const packet of input.shipments)
      for (const observation of packet.observations)
        if (
          observation.timeBasis === "notification_received" &&
          (input.source.kind === "tracking_page" ||
            notificationDate === null ||
            observation.time.kind !== "date" ||
            observation.time.value !== notificationDate)
        )
          refuse(
            "Notification fallback must use the source notification's Los Angeles calendar date.",
          );
    const purchaseId = await purchaseReference(tdb, input.purchaseId);
    await assertPurchaseSourceOwner(tdb, purchaseId, ownerId);
    const shipmentIds = [];
    const unresolvedPackages: {
      sourceShipmentKey: string | null;
      reason: string;
    }[] = [];
    let insertedObservations = 0;
    let repeatedObservations = 0;
    const observedAt =
      input.source.kind !== "email"
        ? new Date(input.source.capturedAt)
        : new Date();
    const sourceEvidence = carrierCaptureEvidence(capture);
    const deliveryCodes = deliveryFieldCodes(sourceEvidence);
    for (const submitted of input.shipments) {
      // Keys, fingerprints and observation identities keep the submitted hints, so
      // retained extractions replay onto their existing bindings and revisions.
      const extraHints: typeof submitted.extraTrackingNumbers = [];
      for (const extra of submitted.extraTrackingNumbers)
        extraHints.push(
          await withoutDeliveryFieldCarrier(tdb, extra, deliveryCodes),
        );
      const packet = {
        ...submitted,
        ...(await withoutDeliveryFieldCarrier(
          tdb,
          {
            carrierId: submitted.carrierId,
            carrierName: submitted.carrierName,
          },
          deliveryCodes,
        )),
        extraTrackingNumbers: extraHints,
      };
      if (packet.carrierId)
        await carrierReference(tdb, packet.carrierId, packet.carrierName);
      const suggestion = await assessCarrierPacket(tdb, packet, sourceEvidence);
      // Explicit source attribution wins over extraction; normal extracted Vendor names
      // still populate a new/missing carrier without a separate proof ledger.
      let carrier = suggestion.primary.carrier
        ? await carrierReference(tdb, suggestion.primary.carrier.code, null)
        : packet.carrierClaims?.some(
              (claim) =>
                claim.role === "intermediary" &&
                normalizeNumber(claim.trackingNumber) ===
                  normalizeNumber(packet.trackingNumber ?? ""),
            )
          ? { id: null, code: null }
          : await carrierReference(tdb, packet.carrierId, packet.carrierName);
      const number = packet.trackingNumber
        ? normalizeNumber(packet.trackingNumber)
        : null;
      const packageKey =
        packet.sourceShipmentKey ??
        packet.shipmentId ??
        `${submitted.carrierId ?? submitted.carrierName ?? "unknown"}:${number}`;
      let row = packet.shipmentId
        ? await canonicalShipment(tdb, packet.shipmentId)
        : undefined;
      const sourcePackages = await database
        .select()
        .from(shipmentSourcePackage)
        .where(eq(shipmentSourcePackage.sourceKey, sourceKey));
      const respelled = sourcePackages.filter(
        (known) =>
          sourcePackageSpelling(known.packageKey) ===
          sourcePackageSpelling(packageKey),
      );
      let binding =
        sourcePackages.find((known) => known.packageKey === packageKey) ??
        (respelled.length === 1 ? respelled[0] : undefined);
      let sourceBindingAmbiguous = !binding && respelled.length > 1;
      if (!binding && !packet.sourceShipmentKey && number) {
        const priorBindings = await database
          .select({ binding: shipmentSourcePackage })
          .from(shipmentSourcePackage)
          .innerJoin(
            shipmentObservation,
            eq(shipmentObservation.sourcePackageId, shipmentSourcePackage.id),
          )
          .where(
            and(
              eq(shipmentSourcePackage.sourceKey, sourceKey),
              sql`upper(regexp_replace(${shipmentObservation.event}->>'trackingNumber', '[[:space:]]', '', 'g')) = ${number}`,
            ),
          );
        const packetBindings = await database
          .select({ binding: shipmentSourcePackage })
          .from(shipmentSourcePackage)
          .innerJoin(
            shipment,
            eq(shipment.id, shipmentSourcePackage.shipmentId),
          )
          .where(
            and(
              eq(shipmentSourcePackage.sourceKey, sourceKey),
              sql`(
            upper(regexp_replace(${shipment.trackingNumber}, '[[:space:]]', '', 'g')) = ${number}
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(${shipment.extraTrackingNumbers}) ref
              WHERE upper(regexp_replace(ref->>'trackingNumber', '[[:space:]]', '', 'g')) = ${number})
          )`,
            ),
          );
        const uniqueBindings = [
          ...new Map(
            [...priorBindings, ...packetBindings].map(({ binding }) => [
              binding.id,
              binding,
            ]),
          ).values(),
        ];
        if (uniqueBindings.length === 1) binding = uniqueBindings[0];
        sourceBindingAmbiguous ||= uniqueBindings.length > 1;
      }
      // Re-extraction can rename a retired template to any key. Tracked siblings still
      // apply; an unbound trackingless packet in this source stays visible instead.
      if (!binding && !row && !number && sourcePackages.length) {
        const [retired] = await database
          .select({ id: shipment.id })
          .from(shipment)
          .where(
            and(
              inArray(
                shipment.id,
                sourcePackages.map((known) => known.shipmentId),
              ),
              isNotNull(shipment.deletedAt),
            ),
          )
          .limit(1);
        if (retired) {
          unresolvedPackages.push({
            sourceShipmentKey: packet.sourceShipmentKey,
            reason:
              "This source has a retired package; review this trackingless packet before creating another Shipment.",
          });
          continue;
        }
      }
      if (binding) {
        const [bound] = await database
          .select()
          .from(shipment)
          .where(eq(shipment.id, binding.shipmentId));
        if (!bound) return refuse("The source package reference is missing.");
        // Merges and reassignment move bindings, so a deleted target is a member's
        // retirement. The capture stays; sibling packets in this source still apply.
        if (bound.deletedAt && !row) {
          unresolvedPackages.push({
            sourceShipmentKey: packet.sourceShipmentKey,
            reason:
              "This source package was retired; its original source remains retained and no Shipment was restored.",
          });
          continue;
        }
        const resolved = await canonicalShipment(tdb, bound.shortcode);
        if (row && row.id !== resolved.id)
          return refuse(
            "This source package already belongs to another Shipment; explicitly reassign it.",
          );
        row = resolved;
      }
      if (row && purchaseId)
        await assertShipmentAssociation(tdb, row.id, purchaseId);
      const [boundCarrier] =
        row?.carrierId && binding
          ? await database
              .select({ code: vendor.shortcode, name: vendor.name })
              .from(vendor)
              .where(eq(vendor.id, row.carrierId))
          : [];
      // Replay follows the existing package assignment; an unsubstantiated re-extraction
      // cannot restore an old guess or invent an additional handoff.
      if (boundCarrier && row && !suggestion.primary.carrier)
        carrier = {
          id: row.carrierId,
          code: parseShortcodeFor("vendor", boundCarrier.code),
        };
      const extraTrackingNumbers = [];
      for (const extra of packet.extraTrackingNumbers) {
        const number = normalizeNumber(extra.trackingNumber);
        const supported = suggestion.forReference(number).carrier;
        const retained =
          binding && row
            ? [
                ...(row.trackingNumber &&
                normalizeNumber(row.trackingNumber) === number &&
                boundCarrier
                  ? [
                      {
                        carrierId: parseShortcodeFor(
                          "vendor",
                          boundCarrier.code,
                        ),
                        carrierName: boundCarrier.name,
                      },
                    ]
                  : []),
                ...row.extraTrackingNumbers.filter(
                  (ref) =>
                    normalizeNumber(ref.trackingNumber) === number &&
                    ref.carrierId,
                ),
              ]
            : [];
        const known = [...new Set(retained.map((ref) => ref.carrierId))];
        const intermediary = packet.carrierClaims?.some(
          (claim) =>
            claim.role === "intermediary" &&
            normalizeNumber(claim.trackingNumber) === number,
        );
        const reference = supported
          ? await carrierReference(tdb, supported.code, null)
          : retained.length
            ? { code: known.length === 1 ? (known[0] ?? null) : null }
            : intermediary
              ? { code: null }
              : await carrierReference(tdb, extra.carrierId, extra.carrierName);
        extraTrackingNumbers.push({
          carrierId: reference.code,
          carrierName:
            supported?.name ?? retained[0]?.carrierName ?? extra.carrierName,
          trackingNumber: number,
        });
      }
      const primaryCarrierCode =
        carrier.code ??
        (row?.trackingNumber && normalizeNumber(row.trackingNumber) === number
          ? (boundCarrier?.code ?? null)
          : null);
      const references = [
        ...(number ? [{ number, carrier: primaryCarrierCode }] : []),
        ...extraTrackingNumbers.map((ref) => ({
          number: ref.trackingNumber,
          carrier: ref.carrierId,
        })),
      ];
      const history = binding
        ? await database
            .select()
            .from(shipmentObservation)
            .where(eq(shipmentObservation.sourcePackageId, binding.id))
        : [];
      const identified = await packetObservationIdentities(
        tdb,
        capture.id,
        packet.observations,
        history,
      );
      const effectiveObservations = [];
      for (const key of identified) {
        const { observation } = key;
        const versions = history
          .filter((version) => version.occurrenceKey === key.occurrenceKey)
          .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime());
        const current = versions.find((version) => !version.supersededById);
        const matching = versions.filter(
          (version) =>
            version.fingerprint === key.fingerprint ||
            (version.event.timeBasis === undefined &&
              version.fingerprint === key.literalFingerprint),
        );
        const prior =
          matching.find((version) => version.firstSeenAt <= observedAt) ??
          matching.at(-1);
        const restored =
          prior?.supersededById &&
          current &&
          !current.memberReviewed &&
          observedAt >= current.lastSeenAt &&
          observedAt > prior.lastSeenAt;
        // Period admission must use the same retained/reviewed revision replay keeps.
        const keepCurrent =
          current &&
          (current.memberReviewed ||
            (prior && !restored) ||
            current.lastSeenAt >= observedAt);
        effectiveObservations.push(keepCurrent ? current.event : observation);
      }
      const identity = await identityCandidates(
        tdb,
        references,
        effectiveObservations,
        notificationDate,
      );
      // Resolve the final candidate before source and complete-period checks, including additional references.
      if (
        !row &&
        !packet.distinctPackageEvidence &&
        identity.candidates.length === 1 &&
        identity.candidates[0]
      ) {
        const proposed = await canonicalShipment(
          tdb,
          identity.candidates[0].shortcode,
        );
        if (
          !purchaseId ||
          !proposed.purchaseId ||
          proposed.purchaseId === purchaseId
        )
          row = proposed;
      }
      let retainedPackageAmbiguous = false;
      if (!row && !number && packet.sourceShipmentKey) {
        const retained = await retainedPackageShipment(tdb, {
          capture,
          ownerId,
          packageKey: packet.sourceShipmentKey,
          purpose: packet.purpose,
          purchaseId,
          window: identity.window,
        });
        retainedPackageAmbiguous = retained === "ambiguous";
        if (retained !== "ambiguous") row = retained;
      }
      const existingDates = row
        ? identityWindowSchema.parse(
            (
              await database.execute(
                sql`SELECT first_day::text AS first, last_day::text AS last FROM shipment_identity_window(${row.id}::uuid)`,
                "objects",
              )
            )[0],
          )
        : null;
      let carrierIssue: string | null = sourceBindingAmbiguous
        ? "The source has multiple package bindings for this reference; review the original source key before alias re-extraction."
        : carrierClaimsConflict(suggestion.explicit)
          ? "Explicit package-specific carrier claims conflict; retain them for handoff review."
          : null;
      if (row || references.length) {
        // Unresolved source claims also constrain first admission, before a Shipment exists.
        const history = await loadCarrierHistory(tdb, {
          ...(row ? { shipmentId: row.id } : { window: identity.window }),
          references: references.map((ref) => ref.number),
        });
        if (history.truncated)
          carrierIssue =
            "Carrier evidence exceeds the bounded history scan; review before correction.";
        else if (
          carrierClaimsConflict([...suggestion.explicit, ...history.claims])
        )
          carrierIssue =
            "Conflicting explicit carrier evidence may describe a handoff; review before association or correction.";
      }
      let correctingCarrier = false;
      if (
        row &&
        carrier.id &&
        row.carrierId &&
        row.carrierId !== carrier.id &&
        (!row.trackingNumber || normalizeNumber(row.trackingNumber) === number)
      ) {
        if (suggestion.primary.carrier) correctingCarrier = !carrierIssue;
        else
          carrierIssue ??=
            "Carrier claims disagree; inspect the retained source before replacing the stored carrier.";
      }
      const currentRowId = row?.id;
      if (
        row &&
        identity.candidates.some(
          (candidate) =>
            candidate.id === currentRowId && candidate.carrier_conflict,
        ) &&
        !correctingCarrier
      )
        carrierIssue ??=
          "Nearby tracking evidence has conflicting carrier identity; review before association.";
      const projection = row
        ? await projectCarrierReferences(tdb, {
            row,
            carrier,
            number,
            extraTrackingNumbers,
            correctingCarrier,
            carrierName: suggestion.primary.carrier?.name ?? null,
          })
        : null;
      let projectedCollision = false;
      if (row && projection && correctingCarrier) {
        const [primaryCarrier] = projection.carrierId
          ? await database
              .select({ code: vendor.shortcode })
              .from(vendor)
              .where(eq(vendor.id, projection.carrierId))
          : [];
        const completeReferences = [
          ...(projection.trackingNumber
            ? [
                {
                  number: normalizeNumber(projection.trackingNumber),
                  carrier: primaryCarrier?.code ?? null,
                },
              ]
            : []),
          ...projection.extraTrackingNumbers.map((ref) => ({
            number: normalizeNumber(ref.trackingNumber),
            carrier: ref.carrierId,
          })),
        ];
        const complete = await identityCandidates(
          tdb,
          completeReferences,
          effectiveObservations,
          notificationDate,
        );
        projectedCollision = complete.candidates.some(
          (candidate) =>
            candidate.id !== currentRowId && !candidate.carrier_conflict,
        );
      }
      const possible = identity.candidates.filter(
        (candidate) =>
          candidate.id !== row?.id && (!row || !candidate.carrier_conflict),
      );
      const candidate = !row && possible.length === 1 ? possible[0] : undefined;
      let ambiguity: string | null =
        carrierIssue ??
        (retainedPackageAmbiguous
          ? "Retained sources cannot prove which nearby Shipment is this linked parcel; review them before associating it."
          : null);
      if (
        !row &&
        possible.length > 0 &&
        references.length &&
        packet.distinctPackageEvidence
      )
        ambiguity =
          "A separate-package claim under a tracking reference requires member review; the source is retained without creating another Shipment.";
      else if (
        references.length &&
        (!identity.window.first ||
          !withinIdentityPeriod([identity.window.first, identity.window.last]))
      )
        ambiguity =
          "Tracking identity needs non-estimated source-event dates within one 60-day period.";
      else if (
        references.length &&
        existingDates &&
        (!existingDates.first ||
          !withinIdentityPeriod([
            identity.window.first,
            identity.window.last,
            existingDates.first,
            existingDates.last,
          ]))
      )
        ambiguity =
          "The proposed evidence spans separate shipping periods; review its source-package association.";
      else if (possible.length > (row ? 0 : 1))
        ambiguity =
          "Multiple nearby Shipments share this tracking reference; review and merge the retained evidence.";
      else if (
        candidate &&
        (candidate.carrier_conflict ||
          !candidate.first_day ||
          !withinIdentityPeriod([
            identity.window.first,
            identity.window.last,
            candidate.first_day,
            candidate.last_day,
          ]) ||
          (purchaseId &&
            candidate.purchase_id &&
            candidate.purchase_id !== purchaseId))
      )
        ambiguity =
          "Nearby tracking evidence has conflicting carrier, Purchase, or shipping-period identity; review it before association.";
      if (correctingCarrier && (possible.length || projectedCollision))
        ambiguity =
          "Carrier correction collides with another Shipment identity; review without automatic merging.";
      if (ambiguity) {
        unresolvedPackages.push({
          sourceShipmentKey: packet.sourceShipmentKey,
          reason: ambiguity,
        });
        const namedCarrier =
          suggestion.primary.carrier ??
          (await resolveCarrierName(tdb, packet.carrierName));
        const format = number
          ? carrierFormatEvidence(
              number,
              namedCarrier ? [namedCarrier.name, ...namedCarrier.aliases] : [],
            )
          : null;
        const advisory =
          format?.outcome === "ambiguous_match"
            ? " The number format matches multiple carriers; use the retained source."
            : format?.outcome === "unsupported_format" &&
                format.sources.length &&
                namedCarrier
              ? ` This reference is outside the limited published ${namedCarrier.name} format checks; that does not exclude the carrier.`
              : "";
        const [member] = ownerId
          ? [{ id: parseEntityId("ledgerParty", ownerId) }]
          : await database
              .select({ id: ledgerParty.id })
              .from(ledgerParty)
              .where(
                and(
                  eq(ledgerParty.userId, actor.userId),
                  eq(ledgerParty.kind, "member"),
                  notDeleted(ledgerParty),
                ),
              );
        if (member)
          await publishRunFinding(tdb, {
            runId: actor.runId ?? null,
            ledgerPartyId: member.id,
            entityKind: row
              ? "shipment"
              : capture.emailId
                ? "email"
                : "ledgerParty",
            entityId: row?.id ?? capture.emailId ?? member.id,
            kind: "shipment_identity_ambiguous",
            summary: `${ambiguity}${advisory}`,
            proposedFix: null,
            evidenceFingerprint: await sha256Hex(
              canonical({ sourceKey, packageKey, packet: submitted }),
            ),
          });
        continue;
      }
      if (candidate)
        return refuse(
          "The final Shipment candidate must pass source and identity checks before association.",
        );
      if (
        row &&
        !row.purchaseAssociationReviewed &&
        purchaseId &&
        row.purchaseId &&
        row.purchaseId !== purchaseId
      )
        return refuse(
          "The Shipment belongs to another Purchase; explicitly reassign it.",
        );
      if (row) await assertPurchaseSourceOwner(tdb, row.purchaseId, ownerId);
      if (!row) {
        row = await insertWithShortcode(tdb, "shipment", {
          name:
            [suggestion.primary.carrier?.name ?? "Package", number]
              .filter(Boolean)
              .join(" · ") || "Package",
          purchaseId,
          carrierId: carrier.id,
          trackingNumber: number,
          extraTrackingNumbers: await deduplicateShipmentTrackingReferences(
            tdb,
            {
              trackingNumber: number,
              carrierId: carrier.id,
              extraTrackingNumbers,
            },
          ),
          purpose:
            packet.purpose === "unknown" && input.source.kind === "sms_export"
              ? "incoming"
              : packet.purpose,
        });
        await logAuditEntries(tdb, actor, [
          {
            entityKind: "shipment",
            entityId: row.id,
            action: "create",
            changes: {
              name: { from: null, to: row.name },
              carrierId: { from: null, to: row.carrierId },
            },
          },
        ]);
      } else {
        const acceptedPurchaseId = await automaticPurchaseAssociation(
          tdb,
          row,
          purchaseId,
        );
        await database
          .update(shipment)
          .set({
            purchaseId: acceptedPurchaseId,
            ...projection,
          })
          .where(eq(shipment.id, row.id));
        if (projection && projection.carrierId !== row.carrierId) {
          await logAuditEntries(tdb, actor, [
            {
              entityKind: "shipment",
              entityId: row.id,
              action: "update",
              changes: {
                carrierId: { from: row.carrierId, to: projection.carrierId },
              },
            },
          ]);
        }
      }
      const sourcePackage =
        binding ??
        (
          await database
            .insert(shipmentSourcePackage)
            .values({ shipmentId: row.id, sourceKey, packageKey })
            .returning()
        )[0];
      if (!sourcePackage)
        throw new Error("Source package identity was not retained.");
      shipmentIds.push(parseShortcodeFor("shipment", row.shortcode));
      for (const {
        observation,
        fingerprint,
        literalFingerprint,
        occurrenceKey,
        revisesFromSameCapture,
      } of identified) {
        const eventHint = await withoutDeliveryFieldCarrier(
          tdb,
          {
            carrierId: observation.carrierId,
            carrierName: observation.carrierName,
          },
          deliveryCodes,
        );
        const eventCarrier = await carrierReference(
          tdb,
          eventHint.carrierId,
          eventHint.carrierName,
        );
        const event = {
          ...observation,
          ...eventHint,
          carrierId: eventCarrier.code,
        };
        // Provenance was absent in historical JSON. Keep its occurrence identity and
        // fingerprint intact when the same literal scan is replayed with provenance.
        const sameOccurrence = and(
          eq(shipmentObservation.sourcePackageId, sourcePackage.id),
          eq(shipmentObservation.occurrenceKey, occurrenceKey),
        );
        const [current] = await database
          .select()
          .from(shipmentObservation)
          .where(
            and(sameOccurrence, isNull(shipmentObservation.supersededById)),
          )
          .orderBy(desc(shipmentObservation.lastSeenAt))
          .limit(1);
        const versions = await database
          .select()
          .from(shipmentObservation)
          .where(sameOccurrence)
          .orderBy(desc(shipmentObservation.firstSeenAt))
          .then((rows) =>
            rows.filter(
              (version) =>
                version.fingerprint === fingerprint ||
                (version.event.timeBasis === undefined &&
                  version.fingerprint === literalFingerprint),
            ),
          );
        const prior =
          versions.find((version) => version.firstSeenAt <= observedAt) ??
          versions.at(-1);
        // Source revisions may restore A → B → A, but cannot replace a member-reviewed revision.
        const restored =
          prior?.supersededById &&
          current &&
          !current.memberReviewed &&
          observedAt >= current.lastSeenAt &&
          observedAt > prior.lastSeenAt;
        let retainedId: string;
        if (prior && !restored) {
          await database
            .update(shipmentObservation)
            .set({
              firstSeenAt: new Date(
                Math.min(prior.firstSeenAt.getTime(), observedAt.getTime()),
              ),
              lastSeenAt: new Date(
                Math.max(prior.lastSeenAt.getTime(), observedAt.getTime()),
              ),
            })
            .where(eq(shipmentObservation.id, prior.id));
          repeatedObservations++;
          retainedId = prior.id;
        } else {
          // A re-read shares its capture's time, so that time cannot mark it stale.
          const canSupersede =
            !current ||
            (!current.memberReviewed &&
              (revisesFromSameCapture
                ? current.lastSeenAt <= observedAt
                : current.lastSeenAt < observedAt));
          const [created] = await database
            .insert(shipmentObservation)
            .values({
              shipmentId: row.id,
              sourceCaptureId: capture.id,
              sourceKey,
              sourcePackageId: sourcePackage.id,
              sourceEventKey: event.sourceEventKey,
              occurrenceKey,
              fingerprint,
              event,
              firstSeenAt: observedAt,
              lastSeenAt: observedAt,
              supersededById: canSupersede ? null : (current?.id ?? null),
            })
            .returning();
          if (!created)
            throw new Error("Shipment observation was not retained.");
          if (canSupersede)
            await database
              .update(shipmentObservation)
              .set({ supersededById: created.id })
              .where(
                and(
                  sameOccurrence,
                  isNull(shipmentObservation.supersededById),
                  ne(shipmentObservation.id, created.id),
                ),
              );
          insertedObservations++;
          retainedId = created.id;
        }
        await database
          .insert(shipmentObservationCapture)
          .values({
            observationId: retainedId,
            captureId: capture.id,
            firstSeenAt: observedAt,
            lastSeenAt: observedAt,
          })
          .onConflictDoUpdate({
            target: [
              shipmentObservationCapture.observationId,
              shipmentObservationCapture.captureId,
            ],
            set: {
              firstSeenAt: sql`least(${shipmentObservationCapture.firstSeenAt}, ${observedAt})`,
              lastSeenAt: sql`greatest(${shipmentObservationCapture.lastSeenAt}, ${observedAt})`,
            },
          });
      }
      await recordChange(tdb, { kind: "source", categories: ["shipment"] });
    }
    return {
      shipmentIds: [...new Set(shipmentIds)],
      insertedObservations,
      repeatedObservations,
      unresolvedPackages,
    };
  });
}

export async function editShipmentObservation(
  db: Database,
  raw: unknown,
  actor: ActorContext,
) {
  if (actor.runId)
    return refuse("Observation edits require an interactive member decision.");
  const input = editShipmentObservationInput.parse(raw);
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const row = await canonicalShipment(tdb, input.shipmentId);
    const database = getDb(tdb);
    const [original] = await database
      .select()
      .from(shipmentObservation)
      .where(
        and(
          eq(shipmentObservation.id, input.observationId),
          eq(shipmentObservation.shipmentId, row.id),
        ),
      );
    if (!original)
      return refuse("The observation does not belong to this Shipment.");
    const [capture] = await database
      .select()
      .from(shipmentSourceCapture)
      .where(eq(shipmentSourceCapture.id, original.sourceCaptureId));
    if (!capture) return refuse("The retained source capture is missing.");
    if (capture.emailId) {
      const [owner] = await database
        .select({ id: email.id })
        .from(email)
        .innerJoin(ledgerParty, eq(ledgerParty.id, email.ledgerPartyId))
        .where(
          and(
            eq(email.id, capture.emailId),
            notDeleted(email),
            notDeleted(ledgerParty),
            eq(ledgerParty.userId, actor.userId),
          ),
        );
      if (!owner)
        return refuse(
          "The member does not own this observation's Email source.",
        );
    } else if (capture.actorUserId !== actor.userId) {
      return refuse(
        "The member does not own this observation's tracking capture.",
      );
    }
    const event = shipmentObservationInput.parse({
      ...original.event,
      ...input.patch,
    });
    if (
      event.timeBasis === "notification_received" &&
      capture.source.kind === "tracking_page"
    )
      return refuse("Tracking pages do not have a notification receipt date.");
    if (
      event.timeBasis === "notification_received" &&
      event.time.kind !== "date"
    )
      return refuse(
        "Notification fallback uses its calendar date at date-only precision.",
      );
    const carrier = await carrierReference(
      tdb,
      event.carrierId,
      event.carrierName,
    );
    event.carrierId = carrier.code;
    const fingerprint = await sha256Hex(canonical(event));
    const result = { shipmentId: parseShortcodeFor("shipment", row.shortcode) };
    if (original.supersededById) {
      const [successor] = await database
        .select()
        .from(shipmentObservation)
        .where(eq(shipmentObservation.id, original.supersededById));
      if (
        successor &&
        !successor.supersededById &&
        successor.fingerprint === fingerprint &&
        successor.memberReviewed
      )
        return result;
      return refuse(
        "The observation was superseded; read the current revision before editing.",
      );
    }
    if (canonical(original.event) === canonical(event)) return result;
    const now = new Date();
    const [revision] = await database
      .insert(shipmentObservation)
      .values({
        shipmentId: row.id,
        sourceCaptureId: original.sourceCaptureId,
        sourceKey: original.sourceKey,
        sourcePackageId: original.sourcePackageId,
        sourceEventKey: original.sourceEventKey,
        occurrenceKey: original.occurrenceKey,
        fingerprint,
        event,
        memberReviewed: true,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning();
    if (!revision) throw new Error("Observation revision was not retained.");
    await database
      .update(shipmentObservation)
      .set({ supersededById: revision.id })
      .where(eq(shipmentObservation.id, original.id));
    const memberships = await database
      .select()
      .from(shipmentObservationCapture)
      .where(eq(shipmentObservationCapture.observationId, original.id));
    if (memberships.length)
      await database.insert(shipmentObservationCapture).values(
        memberships.map((membership) => ({
          observationId: revision.id,
          captureId: membership.captureId,
          firstSeenAt: membership.firstSeenAt,
          lastSeenAt: membership.lastSeenAt,
        })),
      );
    await logAuditEntries(tdb, actor, [
      {
        entityKind: "shipment",
        entityId: row.id,
        action: "update",
        changes: {
          observation: { from: original.event, to: event },
          observationRevision: { from: original.id, to: revision.id },
        },
      },
    ]);
    return result;
  });
}

export async function associateShipment(
  db: Database,
  raw: unknown,
  actor: ActorContext,
) {
  if (actor.runId)
    return refuse(
      "Shipment reassignment requires an interactive member decision.",
    );
  const input = associateShipmentInput.parse(raw);
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const row = await canonicalShipment(tdb, input.shipmentId);
    const purchaseId = await purchaseReference(tdb, input.purchaseId);
    await assertShipmentAssociation(tdb, row.id, purchaseId);
    await getDb(tdb)
      .update(shipment)
      .set({ purchaseId, purchaseAssociationReviewed: true })
      .where(eq(shipment.id, row.id));
    await logAuditEntries(tdb, actor, [
      {
        entityKind: "shipment",
        entityId: row.id,
        action: "update",
        changes: { purchaseId: { from: row.purchaseId, to: purchaseId } },
      },
    ]);
    await recordChange(tdb, { kind: "source", categories: ["shipment"] });
    return { shipmentId: parseShortcodeFor("shipment", row.shortcode) };
  });
}

export async function mergeShipment(
  db: Database,
  raw: unknown,
  actor: ActorContext,
) {
  if (actor.runId)
    return refuse("Shipment merging requires an interactive member decision.");
  const input = mergeShipmentInput.parse(raw);
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const source = await canonicalShipment(tdb, input.sourceId);
    const target = await canonicalShipment(tdb, input.targetId);
    if (source.id === target.id)
      return { shipmentId: parseShortcodeFor("shipment", target.shortcode) };
    if (shipmentPurposesDisagree(source.purpose, target.purpose))
      return refuse(
        "Shipment directions disagree; explicitly correct the direction before merging.",
      );
    if (
      source.purchaseId &&
      target.purchaseId &&
      source.purchaseId !== target.purchaseId
    )
      return refuse(
        "Shipments belong to different Purchases; explicitly correct the association before merging.",
      );
    if (
      source.purchaseAssociationReviewed &&
      target.purchaseAssociationReviewed &&
      source.purchaseId !== target.purchaseId
    )
      return refuse(
        "Reviewed Shipment associations disagree; correct them before merging.",
      );
    const purchaseId = target.purchaseAssociationReviewed
      ? target.purchaseId
      : source.purchaseAssociationReviewed
        ? source.purchaseId
        : (target.purchaseId ?? source.purchaseId);
    if (purchaseId) {
      const [order] = await getDb(tdb)
        .select({ id: purchase.id })
        .from(purchase)
        .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)))
        .for("share");
      if (!order)
        return refuse("The merged Shipment's Purchase is no longer live.");
    }
    await assertShipmentAssociation(tdb, source.id, purchaseId);
    await assertShipmentAssociation(tdb, target.id, purchaseId);
    const refs = [
      ...target.extraTrackingNumbers,
      ...source.extraTrackingNumbers,
    ];
    if (source.trackingNumber) {
      const carrierId = source.carrierId;
      const [carrier] = carrierId
        ? await getDb(tdb)
            .select()
            .from(vendor)
            .where(eq(vendor.id, carrierId))
            .limit(1)
        : [];
      refs.push({
        carrierId: carrier
          ? parseShortcodeFor("vendor", carrier.shortcode)
          : null,
        carrierName: carrier?.name ?? null,
        trackingNumber: source.trackingNumber,
      });
    }
    const mergedCarrierId =
      target.carrierId ??
      (!target.trackingNumber || target.trackingNumber === source.trackingNumber
        ? source.carrierId
        : null);
    await getDb(tdb)
      .update(shipment)
      .set({
        purchaseId,
        notes: mergeNotes(target.notes, source.notes),
        carrierId: mergedCarrierId,
        trackingNumber: target.trackingNumber ?? source.trackingNumber,
        purpose: target.purpose === "unknown" ? source.purpose : target.purpose,
        purchaseAssociationReviewed:
          target.purchaseAssociationReviewed ||
          source.purchaseAssociationReviewed,
        extraTrackingNumbers: await deduplicateShipmentTrackingReferences(tdb, {
          trackingNumber: target.trackingNumber ?? source.trackingNumber,
          carrierId: mergedCarrierId,
          extraTrackingNumbers: refs,
        }),
      })
      .where(eq(shipment.id, target.id));
    if (mergedCarrierId !== target.carrierId)
      await logAuditEntries(tdb, actor, [
        {
          entityKind: "shipment",
          entityId: target.id,
          action: "update",
          changes: {
            carrierId: { from: target.carrierId, to: mergedCarrierId },
          },
        },
      ]);
    await getDb(tdb)
      .update(shipmentObservation)
      .set({ shipmentId: target.id })
      .where(eq(shipmentObservation.shipmentId, source.id));
    await getDb(tdb)
      .update(shipmentSourcePackage)
      .set({ shipmentId: target.id })
      .where(eq(shipmentSourcePackage.shipmentId, source.id));
    await withTransaction(tdb, (tx) =>
      finalizeMerge(tx, {
        entity: "shipment",
        table: shipment,
        keepId: target.id,
        loserIds: [source.id],
        removal: "soft",
        actor,
        survivorChanges: { mergedFrom: { from: null, to: source.shortcode } },
      }),
    );
    await recordChange(tdb, { kind: "source", categories: ["shipment"] });
    return { shipmentId: parseShortcodeFor("shipment", target.shortcode) };
  });
}

export async function reassignShipmentEvidence(
  db: Database,
  raw: unknown,
  actor: ActorContext,
) {
  if (actor.runId)
    return refuse(
      "Shipment evidence reassignment requires an interactive member decision.",
    );
  const input = reassignShipmentEvidenceInput.parse(raw);
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const target = await canonicalShipment(tdb, input.targetShipmentId);
    const [binding] = await getDb(tdb)
      .select()
      .from(shipmentSourcePackage)
      .where(eq(shipmentSourcePackage.id, input.sourcePackageId))
      .limit(1);
    if (!binding)
      return refuse("The source package identity no longer exists.");
    if (binding.shipmentId === target.id)
      return { shipmentId: parseShortcodeFor("shipment", target.shortcode) };
    const [previous] = await getDb(tdb)
      .select({ shortcode: shipment.shortcode })
      .from(shipment)
      .where(eq(shipment.id, binding.shipmentId));
    if (!previous) return refuse("The previous Shipment is missing.");
    const sources = await getDb(tdb)
      .select({ ownerId: email.ledgerPartyId })
      .from(shipmentObservation)
      .innerJoin(
        shipmentSourceCapture,
        eq(shipmentSourceCapture.id, shipmentObservation.sourceCaptureId),
      )
      .innerJoin(email, eq(email.id, shipmentSourceCapture.emailId))
      .where(eq(shipmentObservation.sourcePackageId, binding.id));
    for (const source of sources)
      await assertPurchaseSourceOwner(tdb, target.purchaseId, source.ownerId);
    await getDb(tdb)
      .update(shipmentSourcePackage)
      .set({ shipmentId: target.id })
      .where(eq(shipmentSourcePackage.id, binding.id));
    await getDb(tdb)
      .update(shipmentObservation)
      .set({ shipmentId: target.id })
      .where(eq(shipmentObservation.sourcePackageId, binding.id));
    const [remaining] = await getDb(tdb)
      .select({ id: shipmentObservation.id })
      .from(shipmentObservation)
      .where(eq(shipmentObservation.shipmentId, binding.shipmentId))
      .limit(1);
    // An emptied source is the same historical package, not another live shell.
    if (!remaining)
      await mergeShipment(
        tdb,
        { sourceId: previous.shortcode, targetId: target.shortcode },
        actor,
      );
    await logAuditEntries(tdb, actor, [
      {
        entityKind: "shipment",
        entityId: target.id,
        action: "update",
        changes: {
          reassignedFromShipmentId: {
            from: previous.shortcode,
            to: target.shortcode,
          },
          sourcePackageId: { from: null, to: input.sourcePackageId },
        },
      },
    ]);
    await recordChange(tdb, { kind: "source", categories: ["shipment"] });
    return { shipmentId: parseShortcodeFor("shipment", target.shortcode) };
  });
}

/** Ordinary carrier and extra-reference edits share the Shipment identity writer and audit history. */
export async function editShipmentReferences(
  db: Database,
  input: {
    shipmentId: ShortcodeFor<"shipment">;
    carrierId?: ShortcodeFor<"vendor"> | null;
    extraTrackingNumbers?: ShipmentExtraTrackingNumberRemovals;
  },
  actor: ActorContext,
) {
  if (actor.runId || actor.channel === "system")
    return refuse(
      "Carrier and tracking reference edits require an interactive member request; automated changes use source intake.",
    );
  return withTransactionDatabase(db, async (tdb) => {
    await lockShipmentWrites(tdb);
    const row = await canonicalShipment(tdb, input.shipmentId);
    const carrierId =
      input.carrierId === undefined
        ? row.carrierId
        : (await carrierReference(tdb, input.carrierId, null)).id;
    // Removal is a member decision; only source intake can establish a new reference
    // and its identity checks. A carrier edit alone removes no distinct reference.
    const current = new Set(
      row.extraTrackingNumbers.map(shipmentTrackingReferenceKey),
    );
    const removed = new Set<string>();
    for (const { key } of input.extraTrackingNumbers ?? []) {
      const identity = shipmentTrackingReferenceKey(key);
      if (!current.has(identity))
        throw createAppError(
          "COLLECTION_PATCH_PRECONDITION_FAILED",
          `Shipment extraTrackingNumbers has no "${key.trackingNumber}" under carrier ${key.carrierId ?? "unknown"} to remove; nothing changed.`,
        );
      removed.add(identity);
    }
    // A reference the new primary covers is no longer a separate handoff, and the
    // replaced carrier is not retained as one.
    const extraTrackingNumbers = await deduplicateShipmentTrackingReferences(
      tdb,
      {
        trackingNumber: row.trackingNumber,
        carrierId,
        extraTrackingNumbers: row.extraTrackingNumbers.filter(
          (ref) => !removed.has(shipmentTrackingReferenceKey(ref)),
        ),
      },
    );
    const changes = {
      ...(carrierId === row.carrierId
        ? {}
        : { carrierId: { from: row.carrierId, to: carrierId } }),
      ...(canonical(extraTrackingNumbers) ===
      canonical(row.extraTrackingNumbers)
        ? {}
        : {
            extraTrackingNumbers: {
              from: row.extraTrackingNumbers,
              to: extraTrackingNumbers,
            },
          }),
    };
    const shipmentId = parseShortcodeFor("shipment", row.shortcode);
    if (!Object.keys(changes).length) return { shipmentId };
    await getDb(tdb)
      .update(shipment)
      .set({ carrierId, extraTrackingNumbers })
      .where(eq(shipment.id, row.id));
    await logAuditEntries(tdb, actor, [
      {
        entityKind: "shipment",
        entityId: row.id,
        action: "update",
        changes,
      },
    ]);
    await recordChange(tdb, { kind: "source", categories: ["shipment"] });
    return { shipmentId };
  });
}

import {
  parseEntityId,
  parseShortcodeFor,
  type PurchaseId,
} from "@cubby/schemas/identifiers";
import type {
  RecordShipmentEvidenceInput,
  ShipmentEvidence,
} from "@cubby/schemas/shipment-evidence";
import type { ShipmentPurpose } from "@cubby/schemas/shipment-fields";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted, withTransaction } from "~/server/db/helpers";
import { requestedRows } from "~/server/db/helpers/requested";
import {
  shipment,
  shipmentObservation,
  shipmentSourceCapture,
  shipmentSourcePackage,
  email,
  purchase,
  vendorAccount,
  vendor,
} from "~/server/db/schema";
import {
  carrierCaptureEvidence,
  resolveCarrierName,
} from "~/server/domains/shipment/repo/carrier-evidence";
import { vendorPackageLink } from "~/server/domains/shipment/repo/carrier-recognition";
import { resolveProductBrand } from "~/server/domains/vendor/repo/product-brand";
import { resolveEntityIdentity } from "~/server/entity-kernel/repo/entity-identity";
import { constraintViolation } from "~/server/errors/app-error";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  canonicalJson,
  jsonSnapshot,
  sha256CanonicalJson,
} from "~/server/lib/canonical-json";

import { deduplicateShipmentTrackingReferences } from "./carrier-references";
import {
  identityWindowSchema,
  withinIdentityPeriod,
  sourcePackageSpelling,
  planCarrierProjection,
} from "./evidence-packet-plan";
export const canonical = (value: unknown) =>
  canonicalJson(jsonSnapshot.parse(value));

/** Same digest as `sha256Hex(canonical(value))`; stored fingerprints keep their bytes. */
export const canonicalDigest = (value: unknown) =>
  sha256CanonicalJson(jsonSnapshot.parse(value));

export const shipmentPurposesDisagree = (
  first: ShipmentPurpose,
  second: ShipmentPurpose,
) => first !== "unknown" && second !== "unknown" && first !== second;

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

export async function retainedPackageShipment(
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
  const packageIds = requestedRows(
    [...packages.values()].map(({ shipmentId }) => ({
      id: shipmentId.toLowerCase(),
    })),
    { id: "text" },
    "requested_package",
  );
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
    .innerJoin(
      sql`LATERAL (SELECT 1 FROM ${packageIds.from} WHERE
        lower(regexp_replace(${shipmentSourcePackage.packageKey}, '[^[:alnum:]]', '', 'g')) = ${spelling}
        OR position(${packageIds.col("id")} in lower(${shipmentSourcePackage.packageKey})) > 0
        LIMIT 1) matched_package`,
      sql`true`,
    )
    .where(
      and(
        notDeleted(shipment),
        ne(shipmentSourcePackage.sourceKey, input.capture.sourceKey),
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
export async function lockShipmentWrites(db: Database) {
  const { householdWrite } = await import("~/server/kernel/api");
  await householdWrite(db, async () => undefined);
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
    return constraintViolation(
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
  if (!row) return constraintViolation("The Shipment is no longer available.");
  return row;
}

export async function carrierReference(
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
      return constraintViolation(
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

export async function purchaseReference(
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
    return constraintViolation(
      "The Purchase changed during shipment intake; read it again.",
    );
  return row.id;
}

export async function projectCarrierReferences(
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
  const { row, correctingCarrier } = input;
  const database = getDb(db);
  const [previousCarrier] =
    correctingCarrier && row.carrierId
      ? await database
          .select({ shortcode: vendor.shortcode })
          .from(vendor)
          .where(eq(vendor.id, row.carrierId))
      : [];
  const projection = planCarrierProjection({ ...input, previousCarrier });
  const uniqueRefs = await deduplicateShipmentTrackingReferences(db, {
    ...projection,
  });
  return {
    carrierId: projection.carrierId,
    trackingNumber: projection.trackingNumber,
    extraTrackingNumbers: uniqueRefs,
  };
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

export async function assertPurchaseSourceOwner(
  db: Database,
  id: PurchaseId | null,
  ownerId: string | null,
) {
  if (!id || !ownerId) return;
  const row = await purchaseSourceOwner(db, id);
  if (!row)
    return constraintViolation("The Shipment's Purchase is no longer live.");
  if (row?.ownerId && row.ownerId !== ownerId)
    constraintViolation(
      "The shipment Email and Purchase belong to different members.",
    );
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

export async function assertShipmentAssociation(
  db: Database,
  shipmentId: string,
  purchaseId: PurchaseId | null,
) {
  if (!purchaseId) return;
  for (const ownerId of await shipmentSourceOwners(db, shipmentId))
    await assertPurchaseSourceOwner(db, purchaseId, ownerId);
}

export async function automaticPurchaseAssociation(
  db: Database,
  row: typeof shipment.$inferSelect,
  purchaseId: PurchaseId | null,
) {
  if (row.purchaseAssociationReviewed || row.purchaseId || !purchaseId)
    return row.purchaseId;
  await assertShipmentAssociation(db, row.id, purchaseId);
  return purchaseId;
}

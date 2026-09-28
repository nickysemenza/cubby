import type { ActorContext } from "@cubby/schemas/context";
import type {
  DeviceId,
  ImageId,
  LedgerPartyId,
  UserId,
} from "@cubby/schemas/identifiers";
import type {
  ImageRecordSightingsOut,
  ImageSightingRecordItem,
} from "@cubby/schemas/image-sighting";
import { and, eq, ne, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { device, image, imageSighting } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { currentMemberLedgerParty } from "~/server/repo/member-login";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";
import { deriveAndStoreImageCapture } from "~/server/services/image-capture-derivation";

/**
 * `ImageSighting` is a child of its Image, not an entity (ADR 0005): rows
 * have no shortcode, every write goes through {@link recordImageSightings}
 * (or a photo-import commit), and the audit history of a sighting is written
 * onto the parent Image as `changes.sightings[<sighting id>]`.
 */

/**
 * The live member ledger party the acting login is linked to, via the
 * member-login mapping (`repo/member-login.ts`'s userId ↔ ledgerParty.userId
 * relation). Unlike Device's owner resolution — where an unlinked login is
 * fine, since a device is useful even unowned — a sighting's owner is
 * required: there is no such thing as an unowned photo-library report, so an
 * unlinked login is refused rather than silently accepted.
 */
async function resolveSightingOwnerParty(
  db: Database | DrizzleTransaction,
  userId: UserId,
): Promise<LedgerPartyId> {
  const row = await currentMemberLedgerParty(db, { userId });
  if (!row) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "This login isn't linked to a member yet. Link it in Settings → Member logins before reporting a photo sighting.",
    );
  }
  return row.id;
}

/**
 * Resolves the photo-import commit's one reporting device (by
 * `installationId`, NOT a shortcode) and the acting login's linked member
 * party. Either missing or unresolvable means no sighting is recorded for
 * that commit — a best-effort enhancement, never a reason to fail the
 * import — so this returns `null` instead of throwing.
 *
 * Lives here (not in `services/photo-import-commit.service.ts`) because
 * services cannot import `~/server/db/schema` directly.
 */
export async function resolveImportSightingContext(
  db: Database | DrizzleTransaction,
  installationId: string | undefined,
  actorUserId: UserId,
): Promise<{ deviceId: DeviceId; ledgerPartyId: LedgerPartyId } | null> {
  if (!installationId) return null;
  const [deviceRow, partyRow] = await Promise.all([
    unwrapDb(db).query.device.findFirst({
      where: and(eq(device.installationId, installationId), notDeleted(device)),
      columns: { id: true },
    }),
    currentMemberLedgerParty(db, { userId: actorUserId }),
  ]);
  if (!deviceRow || !partyRow) return null;
  return { deviceId: deviceRow.id, ledgerPartyId: partyRow.id };
}

/**
 * When a photo-import commit item attests `photoLibrary`/`camera`
 * provenance, the image is the member's own: `source: "own"`,
 * `provenanceEvidence: { basis: "sighting" }`. Guarded so a prior manual
 * confirmation is never overwritten (mirrors `deriveImageCapture`'s
 * "confirmed is sticky" rule).
 *
 * Lives here for the same reason as {@link resolveImportSightingContext}.
 */
export async function setImageOwnDeviceSource(
  db: Database | DrizzleTransaction,
  imageId: ImageId,
): Promise<void> {
  await unwrapDb(db)
    .update(image)
    .set({ source: "own", provenanceEvidence: { basis: "sighting" } })
    .where(
      and(eq(image.id, imageId), ne(image.captureAttribution, "confirmed")),
    );
}

export interface UpsertImageSightingInput {
  imageId: ImageId;
  ledgerPartyId: LedgerPartyId;
  deviceId: DeviceId;
  assetKey: string;
  cloudIdentifier?: string | null | undefined;
  localIdentifier?: string | null | undefined;
  sourceType: ImageSightingRecordItem["sourceType"];
  mediaSubtypes: string[];
  originalFilename?: string | null | undefined;
  pixelWidth?: number | null | undefined;
  pixelHeight?: number | null | undefined;
  hasAdjustments: boolean;
  capturedAt?: Date | null | undefined;
  capturedAtOffsetMinutes?: number | null | undefined;
  addedAt?: Date | null | undefined;
  location?: ImageSightingRecordItem["location"];
  placeName?: string | null | undefined;
  camera?: ImageSightingRecordItem["camera"];
  matchKind: ImageSightingRecordItem["matchKind"];
  hashDistance?: number | null | undefined;
  aspectGate?: boolean | null | undefined;
  observedAt: Date;
}

/**
 * The upsert itself, on an already-open transaction: every caller —
 * {@link recordImageSightings} and the photo-import commit's per-item
 * `library` block — resolves ids and joins one write boundary, then calls
 * this. A repeat report for the same `(imageId, ledgerPartyId, assetKey)` is
 * not an error: it replaces the observation columns on the existing row.
 * Writes one audit row onto the Image and re-derives the image's capture in
 * the same transaction.
 */
export async function upsertImageSightingInTransaction(
  tx: Database | DrizzleTransaction,
  data: UpsertImageSightingInput,
  actor: ActorContext,
): Promise<{ created: boolean }> {
  const now = new Date();
  const assetKey = data.assetKey.trim();
  const observation = {
    cloudIdentifier: data.cloudIdentifier ?? null,
    localIdentifier: data.localIdentifier ?? null,
    deviceId: data.deviceId,
    sourceType: data.sourceType,
    mediaSubtypes: data.mediaSubtypes,
    originalFilename: data.originalFilename ?? null,
    pixelWidth: data.pixelWidth ?? null,
    pixelHeight: data.pixelHeight ?? null,
    hasAdjustments: data.hasAdjustments,
    capturedAt: data.capturedAt ?? null,
    capturedAtOffsetMinutes: data.capturedAtOffsetMinutes ?? null,
    addedAt: data.addedAt ?? null,
    location: data.location ?? null,
    placeName: data.placeName ?? null,
    camera: data.camera ?? null,
    matchKind: data.matchKind,
    hashDistance: data.hashDistance ?? null,
    aspectGate: data.aspectGate ?? null,
    observedAt: data.observedAt,
  };
  const [row] = await unwrapDb(tx)
    .insert(imageSighting)
    .values({
      imageId: data.imageId,
      ledgerPartyId: data.ledgerPartyId,
      assetKey,
      ...observation,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        imageSighting.imageId,
        imageSighting.ledgerPartyId,
        imageSighting.assetKey,
      ],
      // The unique index is partial: a tombstoned row never conflicts.
      targetWhere: sql`${imageSighting.deletedAt} IS NULL`,
      set: { ...observation, updatedAt: now },
    })
    // `xmax = 0` is true only for a row this statement inserted.
    .returning({
      id: imageSighting.id,
      created: sql<boolean>`(xmax = 0)`,
    });
  if (!row) throw new Error("Sighting upsert returned no row");
  await logAuditEntry(tx, actor, {
    entityKind: "image",
    entityId: data.imageId,
    action: "update",
    changes: { sightings: { [row.id]: {} } },
  });
  await deriveAndStoreImageCapture(tx, data.imageId);
  return { created: row.created };
}

/**
 * Record a page of sightings for one or more images: resolve every id
 * (owner falls back to the acting login's linked member party when omitted),
 * upsert each on `(image, owner, assetKey)`. All-or-nothing, so a failed response can simply be
 * resent: the same image, owner and asset key resolves to the existing live
 * row.
 */
export async function recordImageSightings(
  db: Database,
  items: readonly ImageSightingRecordItem[],
  actor: ActorContext,
): Promise<ImageRecordSightingsOut> {
  return withTransaction(db, async (tx) => {
    const images = await resolveAllOrThrow(
      tx,
      "image",
      items.map((item) => item.imageId),
    );
    const devices = await resolveAllOrThrow(
      tx,
      "device",
      items.map((item) => item.deviceId),
    );
    const explicitOwners = uniq(
      items.flatMap((item) => (item.ledgerPartyId ? [item.ledgerPartyId] : [])),
    );
    const ownerIds = await resolveAllOrThrow(tx, "ledgerParty", explicitOwners);
    const owners = new Map(
      explicitOwners.map((code, index) => [code, ownerIds[index]!]),
    );
    const actingOwner = items.some((item) => !item.ledgerPartyId)
      ? await resolveSightingOwnerParty(tx, actor.userId)
      : null;

    const sightings: ImageRecordSightingsOut["sightings"] = [];
    for (const [index, item] of items.entries()) {
      const owner = item.ledgerPartyId
        ? owners.get(item.ledgerPartyId)
        : actingOwner;
      if (!owner) throw new Error("Sighting owner could not be resolved");
      const { created } = await upsertImageSightingInTransaction(
        tx,
        {
          ...item,
          imageId: images[index]!,
          deviceId: devices[index]!,
          ledgerPartyId: owner,
        },
        actor,
      );
      sightings.push({
        imageId: item.imageId,
        assetKey: item.assetKey.trim(),
        created,
      });
    }
    return {
      processed: items.length,
      created: sightings.filter((sighting) => sighting.created).length,
      sightings,
    };
  });
}

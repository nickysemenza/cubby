import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  DeviceId,
  ImageId,
  ImageSightingId,
  ImageSightingShortcode,
  LedgerPartyId,
  UserId,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  type ImageSightingCreateInput,
  type ImageSightingFilters,
  type ImageSightingOut,
  type ImageSightingUpdateData,
  imageSightingOut,
} from "@cubby/schemas/image-sighting";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, eq, inArray, ne } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { device, image, imageSighting } from "~/server/db/schema";
import { entityRepository } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  buildPartialUpdateValues,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityCrud } from "~/server/repo/entity-crud-factory";
import { listScaffold } from "~/server/repo/list-scaffold";
import { currentMemberLedgerParty } from "~/server/repo/member-login";
import { removeEntity } from "~/server/repo/removal";
import {
  lookupEntityReferences,
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { findOrCreateWithShortcode } from "~/server/repo/shortcode-utils";
import { deriveAndStoreImageCapture } from "~/server/services/image-capture-derivation";

/** No incoming edges point at an image sighting — nothing else references one. */
export const IMAGE_SIGHTING_DELETE_EDGE_POLICY =
  {} as const satisfies IncomingEdgePolicy<
    "imageSighting",
    OperationDisposition
  >;

type ImageSightingRow = typeof imageSighting.$inferSelect;

const scaffold = listScaffold("imageSighting", imageSighting);

const displayDate = (row: ImageSightingRow): string =>
  (row.capturedAt ?? row.observedAt).toISOString().slice(0, 10);

const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: ImageSightingRow[],
): Promise<ImageSightingOut[]> => {
  const [owners, devices, images] = await Promise.all([
    lookupEntityReferences(
      db,
      "ledgerParty",
      rows.map((row) => row.ledgerPartyId),
    ),
    lookupEntityReferences(
      db,
      "device",
      rows.map((row) => row.deviceId),
    ),
    lookupEntityReferences(
      db,
      "image",
      rows.map((row) => row.imageId),
      { includeDeleted: true },
    ),
  ]);
  return rows.map((row) => {
    const owner = owners.get(row.ledgerPartyId);
    const reporter = devices.get(row.deviceId);
    return imageSightingOut.parse({
      ...row,
      id: parseShortcodeFor("imageSighting", row.shortcode),
      imageId: images.get(row.imageId)?.id,
      ledgerPartyId: owner?.id,
      deviceId: reporter?.id,
      displayName: `${owner?.name ?? "Unknown owner"} · ${reporter?.name ?? "Unknown device"} · ${displayDate(row)}`,
    });
  });
};

export const listImageSightings = (
  db: Database,
  filters: ImageSightingFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) =>
  scaffold.list(
    db,
    { filters, sorts, pagination },
    { hydrate: (rows) => hydrate(db, rows) },
  );

const fetchById = async (
  db: Database | DrizzleTransaction,
  id: ImageSightingId,
): Promise<ImageSightingRow | undefined> => {
  const [row] = await unwrapDb(db)
    .select()
    .from(imageSighting)
    .where(and(eq(imageSighting.id, id), notDeleted(imageSighting)))
    .limit(1);
  return row;
};

const imageSightingCrud = createEntityCrud({
  table: imageSighting,
  entity: "imageSighting",
  fetchById,
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
  toUpdate: (data: { placeName?: string | null; capturedAt?: Date | null }) =>
    buildPartialUpdateValues(data),
  auditUpdateFields: [...entityFieldModels.imageSighting.audit],
});

export const getImageSightingByID = imageSightingCrud.getByID;
export const getImageSightingByShortcode = imageSightingCrud.getByShortcode;

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

const observationColumns = (
  data: Omit<
    UpsertImageSightingInput,
    | "imageId"
    | "ledgerPartyId"
    | "assetKey"
    | "cloudIdentifier"
    | "localIdentifier"
  >,
) => ({
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
});

export interface UpsertImageSightingInput {
  imageId: ImageId;
  ledgerPartyId: LedgerPartyId;
  deviceId: DeviceId;
  assetKey: string;
  cloudIdentifier?: string | null | undefined;
  localIdentifier?: string | null | undefined;
  sourceType: ImageSightingCreateInput["sourceType"];
  mediaSubtypes: string[];
  originalFilename?: string | null | undefined;
  pixelWidth?: number | null | undefined;
  pixelHeight?: number | null | undefined;
  hasAdjustments: boolean;
  capturedAt?: Date | null | undefined;
  capturedAtOffsetMinutes?: number | null | undefined;
  addedAt?: Date | null | undefined;
  location?: ImageSightingCreateInput["location"];
  placeName?: string | null | undefined;
  camera?: ImageSightingCreateInput["camera"];
  matchKind: ImageSightingCreateInput["matchKind"];
  hashDistance?: number | null | undefined;
  aspectGate?: boolean | null | undefined;
  observedAt: Date;
}

/**
 * The upsert itself, on an already-open transaction: every caller — the
 * generic `create` adapter below and the photo-import commit's per-item
 * `library` block — resolves ids and joins one write boundary, then calls
 * this. A repeat report for the same `(imageId, ledgerPartyId, assetKey)` is
 * not an error: it replaces the observation columns on the existing row and
 * keeps its shortcode. Always runs `deriveAndStoreImageCapture` for the
 * affected image in the same transaction.
 */
export async function upsertImageSightingInTransaction(
  tx: Database | DrizzleTransaction,
  data: UpsertImageSightingInput,
  actor: ActorContext,
): Promise<{ id: ImageSightingId; created: boolean }> {
  const observation = observationColumns(data);
  const assetKey = data.assetKey.trim();
  const now = new Date();
  const { row, created } = await findOrCreateWithShortcode(
    tx,
    "imageSighting",
    {
      where: and(
        eq(imageSighting.imageId, data.imageId),
        eq(imageSighting.ledgerPartyId, data.ledgerPartyId),
        eq(imageSighting.assetKey, assetKey),
        notDeleted(imageSighting),
      ),
      values: () => ({
        imageId: data.imageId,
        ledgerPartyId: data.ledgerPartyId,
        assetKey,
        cloudIdentifier: data.cloudIdentifier ?? null,
        localIdentifier: data.localIdentifier ?? null,
        ...observation,
        createdAt: now,
        updatedAt: now,
      }),
    },
  );
  if (!created) {
    await unwrapDb(tx)
      .update(imageSighting)
      .set({
        ...observation,
        cloudIdentifier: data.cloudIdentifier ?? null,
        localIdentifier: data.localIdentifier ?? null,
        updatedAt: now,
      })
      .where(eq(imageSighting.id, row.id));
  }
  await logAuditEntry(tx, actor, {
    entityType: "imageSighting",
    entityId: row.id,
    action: created ? "create" : "update",
  });
  await deriveAndStoreImageCapture(tx, data.imageId);
  return { id: row.id, created };
}

/**
 * Report a sighting through the generic entity surface: resolve every id
 * (owner falls back to the acting login's linked member party when omitted),
 * then delegate to {@link upsertImageSightingInTransaction}.
 */
export async function createImageSighting(
  db: Database,
  data: ImageSightingCreateInput,
  actor: ActorContext,
): Promise<{ output: ImageSightingOut; entityId: ImageSightingId }> {
  const id = await withTransaction(db, async (tx) => {
    const imageId = await resolveOrThrow(tx, "image", data.imageId);
    const ledgerPartyId =
      data.ledgerPartyId === undefined
        ? await resolveSightingOwnerParty(tx, actor.userId)
        : await resolveOrThrow(tx, "ledgerParty", data.ledgerPartyId);
    const deviceId = await resolveOrThrow(tx, "device", data.deviceId);
    const { id: sightingId } = await upsertImageSightingInTransaction(
      tx,
      { ...data, imageId, ledgerPartyId, deviceId },
      actor,
    );
    return parseEntityId("imageSighting", sightingId);
  });
  return { output: await imageSightingCrud.getByID(db, id), entityId: id };
}

/** All-or-nothing page: a failed response can be resent because the same image, owner and asset
 * key resolves to the existing live row. The transaction includes capture derivation and audit. */
export async function upsertImageSightingPage(
  db: Database,
  items: ImageSightingCreateInput[],
  actor: ActorContext,
): Promise<{ processed: number; created: number }> {
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
    const explicitOwners = items.flatMap((item) =>
      item.ledgerPartyId ? [item.ledgerPartyId] : [],
    );
    const ownerIDs = await resolveAllOrThrow(tx, "ledgerParty", explicitOwners);
    const owners = new Map(
      explicitOwners.map((code, index) => [code, ownerIDs[index]!]),
    );
    const actingOwner = items.some((item) => !item.ledgerPartyId)
      ? await resolveSightingOwnerParty(tx, actor.userId)
      : null;
    let created = 0;
    for (const [index, item] of items.entries()) {
      const owner = item.ledgerPartyId
        ? owners.get(item.ledgerPartyId)
        : actingOwner;
      if (!owner) throw new Error("Sighting owner could not be resolved");
      const outcome = await upsertImageSightingInTransaction(
        tx,
        {
          ...item,
          imageId: images[index]!,
          deviceId: devices[index]!,
          ledgerPartyId: owner,
        },
        actor,
      );
      if (outcome.created) created += 1;
    }
    return { processed: items.length, created };
  });
}

export async function updateImageSighting(
  db: Database,
  shortcode: ImageSightingShortcode,
  data: ImageSightingUpdateData,
  actor: ActorContext,
): Promise<{ output: ImageSightingOut; entityId: ImageSightingId }> {
  const id = await resolveOrThrow(db, "imageSighting", shortcode);
  return withTransaction(db, async (tx) => {
    const output = await imageSightingCrud.update(tx, id, data, actor);
    const imageId = await resolveOrThrow(tx, "image", output.imageId);
    await deriveAndStoreImageCapture(tx, imageId);
    return { output, entityId: id };
  });
}

export async function deleteImageSightings(
  db: Database,
  shortcodes: ImageSightingShortcode[],
  actor: ActorContext,
) {
  const ids = uniq(await resolveAllOrThrow(db, "imageSighting", shortcodes));
  return withTransaction(db, async (tx) => {
    // Read the affected images BEFORE the soft delete — `notDeleted` would
    // otherwise exclude these very rows from the read that finds them.
    const rows = await unwrapDb(tx)
      .select({ imageId: imageSighting.imageId })
      .from(imageSighting)
      .where(and(inArray(imageSighting.id, ids), notDeleted(imageSighting)));
    const affectedImageIds = uniq(rows.map((row) => row.imageId));
    await removeEntity(tx, {
      entity: "imageSighting",
      ids,
      removal: "soft",
      actor,
    });
    for (const imageId of affectedImageIds) {
      await deriveAndStoreImageCapture(tx, parseEntityId("image", imageId));
    }
    return { deleted: ids.length };
  });
}

export const imageSightingRepository = entityRepository({
  lifecycle: { delete: IMAGE_SIGHTING_DELETE_EDGE_POLICY },
  get: getImageSightingByShortcode,
  list: listImageSightings,
  create: createImageSighting,
  update: updateImageSighting,
  delete: deleteImageSightings,
});

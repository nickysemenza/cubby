import type { ActorContext } from "@cubby/schemas/context";
import {
  type DeviceCreateInput,
  type DeviceFilters,
  type DeviceOut,
  type DeviceUpdateData,
  deviceOut,
} from "@cubby/schemas/device";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  DeviceId,
  DeviceShortcode,
  LedgerPartyId,
  ProductId,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, eq, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { device, imageSighting } from "~/server/db/schema";
import { entityRepository } from "~/server/entity-kernel/adapter";
import { logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  buildPartialUpdateValues,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityCrud } from "~/server/repo/entity-crud-factory";
import { listScaffold } from "~/server/repo/list-scaffold";
import { currentMemberLedgerParty } from "~/server/repo/member-login";
import {
  lookupEntityReferences,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { deriveAndStoreImageCapture } from "~/server/services/image-capture-derivation";

/** `ImageSighting.deviceId` cascades: a sighting reported by a device is
 * meaningless once that device is gone. `AuditLog.deviceId` is cleared. */
export const DEVICE_DELETE_EDGE_POLICY = {
  "AuditLog.deviceId": {
    code: "clearFk",
    effect: "detach",
    description:
      "Audit entries outlive the install; they keep their other attribution.",
  },
  "ImageSighting.deviceId": {
    code: "cascade-sightings",
    effect: "hard-delete",
    description:
      "A device's reported sightings are removed with it; affected images are re-derived in the same transaction.",
  },
} as const satisfies IncomingEdgePolicy<"device", OperationDisposition>;

type DeviceRow = typeof device.$inferSelect;

const scaffold = listScaffold("device", device);

const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: DeviceRow[],
): Promise<DeviceOut[]> => {
  const [parties, products, qualities] = await Promise.all([
    lookupEntityReferences(
      db,
      "ledgerParty",
      rows.map((row) => row.ledgerPartyId),
    ),
    lookupEntityReferences(
      db,
      "product",
      rows.map((row) => row.productId),
    ),
    loadDataQualities(
      db,
      "device",
      rows.map((row) => row.id),
    ),
  ]);
  return rows.map((row) => {
    const party = row.ledgerPartyId ? parties.get(row.ledgerPartyId) : null;
    const hardware = row.productId ? products.get(row.productId) : null;
    return deviceOut.parse({
      ...row,
      id: parseShortcodeFor("device", row.shortcode),
      ledgerPartyId: party?.id ?? null,
      productId: hardware?.id ?? null,
      ledgerPartyName: party?.name ?? null,
      productName: hardware?.name ?? null,
      dataQuality: qualities.get(row.id),
    });
  });
};

export const buildDeviceWhere = (filters: DeviceFilters) =>
  scaffold.where(filters);

export const listDevices = (
  db: Database,
  filters: DeviceFilters,
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
  id: DeviceId,
): Promise<DeviceRow | undefined> => {
  const [row] = await unwrapDb(db)
    .select()
    .from(device)
    .where(and(eq(device.id, id), notDeleted(device)))
    .limit(1);
  return row;
};

const deviceCrud = createEntityCrud({
  table: device,
  entity: "device",
  fetchById,
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
  toUpdate: (data: {
    name?: string;
    appVersion?: string | null;
    osVersion?: string | null;
    lastSeenAt?: Date | null;
    automaticWork?: boolean;
    remotePaused?: boolean;
    ledgerPartyId?: LedgerPartyId | null;
    productId?: ProductId | null;
  }) => buildPartialUpdateValues(data),
  auditUpdateFields: [...entityFieldModels.device.audit],
});

export const getDeviceByID = deviceCrud.getByID;
export const getDeviceByShortcode = deviceCrud.getByShortcode;

export async function createDevice(
  db: Database,
  data: DeviceCreateInput,
  actor: ActorContext,
): Promise<{ output: DeviceOut; entityId: DeviceId }> {
  const id = await withTransaction(db, async (tx) => {
    // When the caller doesn't name an owner, resolve one from the acting
    // login through the member-login mapping — `null` when unlinked, never a
    // hard failure: a device is useful even with no recorded owner.
    const ledgerPartyId =
      data.ledgerPartyId === undefined
        ? ((await currentMemberLedgerParty(tx, actor))?.id ?? null)
        : data.ledgerPartyId === null
          ? null
          : await resolveOrThrow(tx, "ledgerParty", data.ledgerPartyId);
    const productId =
      data.productId === undefined || data.productId === null
        ? null
        : await resolveOrThrow(tx, "product", data.productId);
    const row = await insertWithShortcode(tx, "device", {
      installationId: data.installationId.trim(),
      name: data.name.trim(),
      platform: data.platform,
      appVersion: data.appVersion ?? null,
      osVersion: data.osVersion ?? null,
      automaticWork: data.automaticWork,
      remotePaused: data.remotePaused,
      ledgerPartyId,
      productId,
    });
    await logAuditEntry(tx, actor, {
      entityType: "device",
      entityId: row.id,
      action: "create",
    });
    return parseEntityId("device", row.id);
  });
  return { output: await deviceCrud.getByID(db, id), entityId: id };
}

export async function updateDevice(
  db: Database,
  shortcode: DeviceShortcode,
  data: DeviceUpdateData,
  actor: ActorContext,
): Promise<{ output: DeviceOut; entityId: DeviceId }> {
  const id = await resolveOrThrow(db, "device", shortcode);
  return withTransaction(db, async (tx) => {
    const ledgerPartyId =
      data.ledgerPartyId === undefined
        ? undefined
        : data.ledgerPartyId === null
          ? null
          : await resolveOrThrow(tx, "ledgerParty", data.ledgerPartyId);
    const productId =
      data.productId === undefined
        ? undefined
        : data.productId === null
          ? null
          : await resolveOrThrow(tx, "product", data.productId);
    const output = await deviceCrud.update(
      tx,
      id,
      {
        name: data.name,
        appVersion: data.appVersion,
        osVersion: data.osVersion,
        lastSeenAt: data.lastSeenAt,
        automaticWork: data.automaticWork,
        remotePaused: data.remotePaused,
        ledgerPartyId,
        productId,
      },
      actor,
    );
    return { output, entityId: id };
  });
}

/**
 * A device's reported sightings go with it, and every affected image is
 * re-derived in the same transaction so its capture fields never reflect a
 * sighting that no longer exists.
 */
const deleteDeviceSightings = async (
  tx: DrizzleTransaction,
  ids: DeviceId[],
) => {
  const removed = await tx
    .delete(imageSighting)
    .where(inArray(imageSighting.deviceId, ids))
    .returning({ imageId: imageSighting.imageId });
  for (const imageId of uniq(removed.map((row) => row.imageId)))
    await deriveAndStoreImageCapture(tx, parseEntityId("image", imageId));
};

export const deviceRepository = entityRepository("device", {
  lifecycle: { delete: DEVICE_DELETE_EDGE_POLICY },
  get: getDeviceByShortcode,
  list: listDevices,
  create: createDevice,
  update: updateDevice,
  deleteHooks: {
    overrides: { "ImageSighting.deviceId": deleteDeviceSightings },
  },
});

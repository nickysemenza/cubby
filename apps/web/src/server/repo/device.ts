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
  UserId,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, eq, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  device,
  imageSighting,
  ledgerParty,
  product,
} from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  auditDateWhereConditions,
  buildPartialUpdateValues,
  countWhere,
  executeListQueryWithCount,
  getDb,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityCrud } from "~/server/repo/entity-crud-factory";
import { listScaffold } from "~/server/repo/list-scaffold";
import { removeEntity } from "~/server/repo/removal";
import {
  resolveAllOrThrow,
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

const columns = {
  id: device.id,
  shortcode: device.shortcode,
  installationId: device.installationId,
  name: device.name,
  platform: device.platform,
  appVersion: device.appVersion,
  osVersion: device.osVersion,
  lastSeenAt: device.lastSeenAt,
  automaticWork: device.automaticWork,
  remotePaused: device.remotePaused,
  ledgerPartyId: device.ledgerPartyId,
  productId: device.productId,
  createdAt: device.createdAt,
  updatedAt: device.updatedAt,
} as const;

type DeviceRow = {
  id: DeviceId;
  shortcode: string;
  installationId: string;
  name: string;
  platform: typeof device.$inferSelect.platform;
  appVersion: string | null;
  osVersion: string | null;
  lastSeenAt: Date | null;
  automaticWork: boolean;
  remotePaused: boolean;
  ledgerPartyId: LedgerPartyId | null;
  productId: ProductId | null;
  createdAt: Date;
  updatedAt: Date;
};

const scaffold = listScaffold("device", device);

const toOut = async (
  db: Database | DrizzleTransaction,
  row: DeviceRow,
): Promise<DeviceOut> => {
  const [ledgerPartyRow, productRow] = await Promise.all([
    row.ledgerPartyId
      ? unwrapDb(db).query.ledgerParty.findFirst({
          where: and(
            eq(ledgerParty.id, row.ledgerPartyId),
            notDeleted(ledgerParty),
          ),
          columns: { shortcode: true, name: true },
        })
      : undefined,
    row.productId
      ? unwrapDb(db).query.product.findFirst({
          where: and(eq(product.id, row.productId), notDeleted(product)),
          columns: { shortcode: true, name: true },
        })
      : undefined,
  ]);
  const dataQuality = (await loadDataQualities(db, "device", [row.id])).get(
    row.id,
  )!;
  return deviceOut.parse({
    id: parseShortcodeFor("device", row.shortcode),
    installationId: row.installationId,
    name: row.name,
    platform: row.platform,
    appVersion: row.appVersion,
    osVersion: row.osVersion,
    lastSeenAt: row.lastSeenAt,
    automaticWork: row.automaticWork,
    remotePaused: row.remotePaused,
    ledgerPartyId: ledgerPartyRow
      ? parseShortcodeFor("ledgerParty", ledgerPartyRow.shortcode)
      : null,
    productId: productRow
      ? parseShortcodeFor("product", productRow.shortcode)
      : null,
    ledgerPartyName: ledgerPartyRow?.name ?? null,
    productName: productRow?.name ?? null,
    dataQuality,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
};

const buildWhere = (filters: DeviceFilters) =>
  scaffold.where(filters, [...auditDateWhereConditions(device, filters)]);

export async function listDevices(
  db: Database,
  filters: DeviceFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) {
  const where = buildWhere(filters);
  const { take, skip } = scaffold.page(pagination);
  const { data, count } = await executeListQueryWithCount(
    getDb(db)
      .select(columns)
      .from(device)
      .where(where)
      .orderBy(...scaffold.orderBy(sorts, {}, filters))
      .limit(take)
      .offset(skip),
    countWhere(db, device, where),
  );
  return { data: await Promise.all(data.map((row) => toOut(db, row))), count };
}

const fetchById = async (
  db: Database | DrizzleTransaction,
  id: DeviceId,
): Promise<DeviceRow | undefined> => {
  const [row] = await unwrapDb(db)
    .select(columns)
    .from(device)
    .where(and(eq(device.id, id), notDeleted(device)))
    .limit(1);
  return row;
};

const deviceCrud = createEntityCrud({
  table: device,
  entity: "device",
  fetchById,
  fromDB: (db, row) => toOut(db, row),
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

/** The live member ledger party the acting login is linked to, if any. */
const resolveActorParty = async (
  db: Database | DrizzleTransaction,
  userId: UserId,
): Promise<LedgerPartyId | null> => {
  const [row] = await unwrapDb(db)
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(and(eq(ledgerParty.userId, userId), notDeleted(ledgerParty)))
    .limit(1);
  return row?.id ?? null;
};

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
        ? await resolveActorParty(tx, actor.userId)
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

export async function deleteDevices(
  db: Database,
  shortcodes: DeviceShortcode[],
  actor: ActorContext,
) {
  const ids = uniq(await resolveAllOrThrow(db, "device", shortcodes));
  return withTransaction(db, async (tx) => {
    // "ImageSighting.deviceId" is a "hard-delete" (cascade) disposition: a
    // sighting reported by this device has no meaning once the device is
    // gone. Every affected image is re-derived in this same transaction so
    // its capture fields never reflect a sighting that no longer exists.
    const cascadedSightings = await tx
      .select({ imageId: imageSighting.imageId })
      .from(imageSighting)
      .where(
        and(inArray(imageSighting.deviceId, ids), notDeleted(imageSighting)),
      );
    if (cascadedSightings.length > 0) {
      await tx
        .delete(imageSighting)
        .where(inArray(imageSighting.deviceId, ids));
      for (const imageId of uniq(cascadedSightings.map((row) => row.imageId))) {
        await deriveAndStoreImageCapture(tx, parseEntityId("image", imageId));
      }
    }
    await removeEntity(tx, {
      entity: "device",
      ids,
      removal: "soft",
      actor,
    });
    return { deleted: ids.length };
  });
}

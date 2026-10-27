import type { ActorContext } from "@cubby/schemas/context";
import {
  type DeviceCreateInput,
  type DeviceUpdateData,
} from "@cubby/schemas/device";
import { rawDeviceOut } from "@cubby/schemas/device-raw-read";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  DeviceId,
  DeviceShortcode,
  LedgerPartyId,
  ProductId,
} from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { buildPartialUpdateValues, withTransaction } from "~/server/db/helpers";
import { device, imageSighting, runPushRegistration } from "~/server/db/schema";
import { deriveAndStoreImageCapture } from "~/server/domains/image/repo/image-capture-derivation";
import {
  type MutationReceipt,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import {
  asActor,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { createEntityCrud } from "~/server/entity-kernel/repo/repository";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { listScaffold } from "~/server/generic/list/repo/list";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { appleAppVersionTooOld } from "~/server/http/apple-client-gate";
import { currentMemberLedgerParty } from "~/server/http/member-login";

/** `ImageSighting.deviceId` cascades: a sighting reported by a device is
 * meaningless once that device is gone. `AuditLog.deviceId` and
 * `PhotoRunImage.deviceWorkDeviceId` are cleared. */
const DEVICE_DELETE_EDGE_POLICY = {
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
  "RunPushRegistration.deviceId": {
    code: "cascade-push-registrations",
    effect: "hard-delete",
    description:
      "A removed install receives no more Run pushes; its registrations go with it.",
  },
  "PhotoRunImage.deviceWorkDeviceId": {
    code: "clearFk",
    effect: "detach",
    description:
      "A run target outlives the install that last reported on it; its recorded device-work state is preserved.",
  },
} as const satisfies IncomingEdgePolicy<"device", OperationDisposition>;

/** An install not seen for this long is inactive and leaves Apple lane counts. */
const DEVICE_INACTIVE_AFTER_MS = 7 * 24 * 60 * 60_000;

const deviceInactive = (lastSeenAt: Date | null, now = new Date()) =>
  !lastSeenAt ||
  now.getTime() - lastSeenAt.getTime() > DEVICE_INACTIVE_AFTER_MS;

export const deviceScaffold = listScaffold("device", device, {
  read: {
    bindings: (bind) => {
      // Row-local derivations; per-device leases live on the Activity queue.
      const clock = bind.batch(async () => ({ now: new Date() }));
      return [
        clock.fields(
          rawDeviceOut.pick({ updateRequired: true, inactive: true }),
          (row, { now }) => ({
            updateRequired: appleAppVersionTooOld(row.appVersion),
            inactive: deviceInactive(row.lastSeenAt, now),
          }),
        ),
      ];
    },
  },
});

const deviceCrud = createEntityCrud({
  table: device,
  entity: "device",
  scaffold: deviceScaffold,
  output: rawDeviceOut,
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

export const readDeviceById = deviceCrud.getByID;

export const createDevice = defineMutationWriter({
  entity: "device",
  read: async (
    receipt: MutationReceipt<"device">,
    db: Database,
    _data: DeviceCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await deviceCrud.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: DeviceCreateInput,
    actor: ActorContext,
  ) => {
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
        entityKind: "device",
        entityId: row.id,
        action: "create",
      });
      return parseEntityId("device", row.id);
    });
    return readOutput({ entityId: id });
  },
});

export const updateDevice = defineMutationWriter({
  entity: "device",
  read: async (
    receipt: MutationReceipt<"device">,
    db: Database,
    _shortcode: DeviceShortcode,
    _data: DeviceUpdateData,
    _actor: ActorContext,
  ) => ({
    output: await deviceCrud.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    shortcode: DeviceShortcode,
    data: DeviceUpdateData,
    actor: ActorContext,
  ) => {
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
      const receipt = await deviceCrud.update(
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
        async (_db, receipt) => receipt,
      );
      return readOutput(receipt, async () => ({
        output: await deviceCrud.getByID(tx, id),
        entityId: id,
      }));
    });
  },
});

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

/** A removed install's Run push registrations go with it. */
const deleteDevicePushRegistrations = async (
  tx: DrizzleTransaction,
  ids: DeviceId[],
) => {
  await tx
    .delete(runPushRegistration)
    .where(inArray(runPushRegistration.deviceId, ids));
};

export const deviceRepository = defineRepository("device", {
  lifecycle: { delete: DEVICE_DELETE_EDGE_POLICY },
  scaffold: deviceScaffold,
  create: asActor(createDevice),
  update: asActor(updateDevice),
  deleteHooks: {
    overrides: {
      "ImageSighting.deviceId": deleteDeviceSightings,
      "RunPushRegistration.deviceId": deleteDevicePushRegistrations,
    },
  },
});

import type { ActorContext } from "@cubby/schemas/context";
import { type DeviceCreateInput } from "@cubby/schemas/entities/device";
import { deviceRawOut as rawDeviceOut } from "@cubby/schemas/entity-contracts/device";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { parseEntityId } from "@cubby/schemas/identifiers";

import {
  deviceRepositoryReadSchema,
  deviceSchemaBindings,
} from "~/entity/generated/entity-schema-bindings.device.gen";
import type { Database } from "~/server/db";
import {
  DECLARED_EDGE_DELETE_POLICIES,
  DECLARED_EDGE_DELETE_HOOKS,
} from "~/server/db/generated/declared-edges.gen";
import { buildPartialUpdateValues, withTransaction } from "~/server/db/helpers";
import { device } from "~/server/db/schema";
import { currentMemberLedgerParty } from "~/server/domains/ledger-party/repo/current-member-party";
import {
  type MutationReceipt,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import {
  asActor,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { createEntityCrud } from "~/server/entity-kernel/repo/repository";
import { ENTITY_STORED_WRITES } from "~/server/generated/entity-write-bindings.gen";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { listScaffold } from "~/server/generic/list/repo/list";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { appleAppVersionTooOld } from "~/server/lib/apple-app-version";

/** An install not seen for this long is inactive and leaves Apple lane counts. */
const DEVICE_INACTIVE_AFTER_MS = 7 * 24 * 60 * 60_000;

const deviceInactive = (lastSeenAt: Date | null, now = new Date()) =>
  !lastSeenAt ||
  now.getTime() - lastSeenAt.getTime() > DEVICE_INACTIVE_AFTER_MS;

export const deviceScaffold = listScaffold("device", device, {
  readSchema: deviceRepositoryReadSchema,
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
  toUpdate: (
    data: Awaited<
      ReturnType<typeof ENTITY_STORED_WRITES.device.update>
    >["data"],
  ) => buildPartialUpdateValues(data),
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

export const updateDevice = deviceCrud.updateWriter(
  ENTITY_STORED_WRITES.device.update,
  (output, entityId) => ({ output, entityId }),
);

export const deviceRepository = defineRepository("device", {
  schemas: deviceSchemaBindings,
  lifecycle: { delete: DECLARED_EDGE_DELETE_POLICIES.device },
  scaffold: deviceScaffold,
  create: asActor(createDevice),
  update: asActor(updateDevice),
  deleteHooks: DECLARED_EDGE_DELETE_HOOKS.device,
});

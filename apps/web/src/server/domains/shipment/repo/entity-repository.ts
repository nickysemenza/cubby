import type { ActorContext } from "@cubby/schemas/context";
import { type ShipmentUpdateData } from "@cubby/schemas/entities/shipment";
import { shipmentRawOut as rawShipmentOut } from "@cubby/schemas/entity-contracts/shipment";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeFor } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import {
  buildPartialUpdateValues,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { shipment } from "~/server/db/schema";
import { editShipmentCarrier } from "~/server/domains/shipment/repo/evidence";
import { shipmentSearch } from "~/server/domains/shipment/repo/search-read-shipment";
import {
  createEntityCrud,
  defineRepository,
  asActor,
  defineMutationWriter,
  type MutationReceipt,
} from "~/server/entity-kernel/repo/repository";
import { ENTITY_STORED_WRITES } from "~/server/generated/entity-write-bindings.gen";
import { listScaffold } from "~/server/generic/list/repo/list";

export const shipmentScaffold = listScaffold("shipment", shipment, {
  read: {
    search: shipmentSearch,
    media: true,
    references: {
      purchaseId: {
        kind: "lookup",
        missing: "null",
        includeDeleted: true,
      },
      carrierId: {
        kind: "lookup",
        missing: "null",
        includeDeleted: true,
      },
    },
  },
});

const reader = createEntityCrud({
  table: shipment,
  entity: "shipment",
  scaffold: shipmentScaffold,
  output: rawShipmentOut,
  toUpdate: (data: Pick<ShipmentUpdateData, "purpose">) =>
    buildPartialUpdateValues(data),
  auditUpdateFields: [...entityFieldModels.shipment.audit],
});

const update = reader.updateWriter(
  ENTITY_STORED_WRITES.shipment.update,
  (output, entityId) => ({ output, entityId }),
);

const updateShipment = defineMutationWriter({
  entity: "shipment",
  read: async (
    receipt: MutationReceipt<"shipment">,
    db: Database,
    _code: ShortcodeFor<"shipment">,
    _data: ShipmentUpdateData,
    _actor: ActorContext,
  ) => ({
    output: await reader.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    code: ShortcodeFor<"shipment">,
    data: ShipmentUpdateData,
    actor: ActorContext,
  ) =>
    withTransactionDatabase(db, async (tx) => {
      const { carrierId, ...otherFields } = data;
      // Use the Shipment identity writer before ordinary CRUD locks the record.
      if (carrierId !== undefined)
        await editShipmentCarrier(tx, { shipmentId: code, carrierId }, actor);
      return update.withOutput(readOutput, tx, code, otherFields, actor);
    }),
});

export const shipmentRepository = defineRepository("shipment", {
  scaffold: shipmentScaffold,
  update: asActor(updateShipment),
  updatePolicy: { recordFields: ["carrierId"] },
});

import { type ShipmentUpdateData } from "@cubby/schemas/entities/shipment";
import { shipmentRawOut as rawShipmentOut } from "@cubby/schemas/entity-contracts/shipment";
import { entityFieldModels } from "@cubby/schemas/entity-fields";

import { buildPartialUpdateValues } from "~/server/db/helpers";
import { shipment } from "~/server/db/schema";
import { shipmentSearch } from "~/server/domains/shipment/repo/search-read-shipment";
import {
  createEntityCrud,
  defineRepository,
  asActor,
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
  toUpdate: (data: ShipmentUpdateData) => buildPartialUpdateValues(data),
  auditUpdateFields: [...entityFieldModels.shipment.audit],
});

const update = reader.updateWriter(
  ENTITY_STORED_WRITES.shipment.update,
  (output, entityId) => ({ output, entityId }),
);

export const shipmentRepository = defineRepository("shipment", {
  scaffold: shipmentScaffold,
  update: asActor(update),
});

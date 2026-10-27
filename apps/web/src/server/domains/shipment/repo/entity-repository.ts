import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeFor } from "@cubby/schemas/identifiers";
import { type ShipmentUpdateData } from "@cubby/schemas/shipment";
import { rawShipmentOut } from "@cubby/schemas/shipment-raw-read";

import type { Database } from "~/server/db";
import {
  buildPartialUpdateValues,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { shipment } from "~/server/db/schema";
import { shipmentSearch } from "~/server/domains/shipment/repo/search-read-shipment";
import {
  createEntityCrud,
  defineRepository,
  defineMutationWriter,
  asActor,
  type MutationReceipt,
} from "~/server/entity-kernel/repo/repository";
import { listScaffold } from "~/server/generic/list/repo/list";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

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

const update = defineMutationWriter({
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
  write: (
    readOutput,
    db: Database,
    code: ShortcodeFor<"shipment">,
    data: ShipmentUpdateData,
    actor: ActorContext,
  ) =>
    withTransactionDatabase(db, async (tx) => {
      const id = await resolveOrThrow(tx, "shipment", code);
      return reader.update(tx, id, data, actor, (db, receipt) =>
        readOutput(receipt, async () => ({
          output: await reader.getByID(db, id),
          entityId: id,
        })),
      );
    }),
});

export const shipmentRepository = defineRepository("shipment", {
  scaffold: shipmentScaffold,
  update: asActor(update),
});

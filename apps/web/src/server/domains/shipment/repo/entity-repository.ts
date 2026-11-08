import type { ActorContext } from "@cubby/schemas/context";
import { type ShipmentUpdateData } from "@cubby/schemas/entities/shipment";
import { shipmentRawOut as rawShipmentOut } from "@cubby/schemas/entity-contracts/shipment";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { ShortcodeFor } from "@cubby/schemas/identifiers";

import {
  shipmentRepositoryReadSchema,
  shipmentSchemaBindings,
} from "~/entity/generated/entity-schema-bindings.shipment.gen";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  buildPartialUpdateValues,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { shipment } from "~/server/db/schema";
import { editShipmentReferences } from "~/server/domains/shipment/repo/evidence";
import { shipmentSearch } from "~/server/domains/shipment/repo/search-read-shipment";
import {
  createEntityCrud,
  defineRepository,
  asActor,
  defineMutationWriter,
  type MutationReceipt,
} from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import { listScaffold } from "~/server/generic/list/repo/list";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

export const shipmentScaffold = listScaffold("shipment", shipment, {
  readSchema: shipmentRepositoryReadSchema,
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
  async (
    db: DrizzleTransaction,
    code: ShortcodeFor<"shipment">,
    data: Pick<ShipmentUpdateData, "purpose">,
  ) => ({ id: await resolveOrThrow(db, "shipment", code), data }),
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
      const { carrierId, extraTrackingNumbers, ...otherFields } = data;
      // Use the Shipment identity writer before ordinary CRUD locks the record.
      if (carrierId !== undefined || extraTrackingNumbers !== undefined)
        await editShipmentReferences(
          tx,
          { shipmentId: code, carrierId, extraTrackingNumbers },
          actor,
        );
      return update.withOutput(readOutput, tx, code, otherFields, actor);
    }),
});

const SHIPMENT_DELETE_EDGE_POLICY = {
  "ShipmentObservation.shipmentId": {
    code: "preserve-tracking-observations",
    effect: "preserve",
    description:
      "A retired package keeps its retained observations and capture memberships.",
  },
  "ShipmentSourcePackage.shipmentId": {
    code: "preserve-source-package-binding",
    effect: "preserve",
    description:
      "A retired package keeps its source binding, so replay cannot recreate it.",
  },
} as const satisfies IncomingEdgePolicy<"shipment", OperationDisposition>;

export const shipmentRepository = defineRepository("shipment", {
  schemas: shipmentSchemaBindings,
  lifecycle: { delete: SHIPMENT_DELETE_EDGE_POLICY },
  scaffold: shipmentScaffold,
  delete: async (ctx, ids) => {
    if (ctx.actorContext.runId || ctx.actorContext.channel === "system")
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Retiring a Shipment requires an interactive member decision.",
      );
    const { policyDelete } =
      await import("~/server/generic/removal/repo/dispositions");
    return policyDelete("shipment", SHIPMENT_DELETE_EDGE_POLICY)(
      ctx.db,
      ids,
      ctx.actorContext,
    );
  },
  update: asActor(updateShipment),
  updatePolicy: { recordFields: ["carrierId"] },
});

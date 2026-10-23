import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import {
  shipmentOut,
  type ShipmentFilters,
  type ShipmentOut,
  type ShipmentUpdateData,
} from "@cubby/schemas/shipment";
import { and, eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  buildPartialUpdateValues,
  notDeleted,
  unwrapDb,
  withTransactionDatabase,
} from "~/server/db/helpers";
import type { ListReadIntent } from "~/server/db/helpers/query";
import { shipment } from "~/server/db/schema";
import {
  loadShipmentEventSummaries,
  shipmentEventSummaries,
  shipmentSummarySort,
} from "~/server/domains/shipment/repo/event-summary";
import { shipmentEventSummary } from "~/server/domains/shipment/repo/timeline";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  createEntityCrud,
  defineRepository,
  defineMutationWriter,
  asActor,
  type MutationReceipt,
} from "~/server/entity-kernel/repo/repository";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listReadPlan,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

type ReaderDb = Database | DrizzleTransaction;
type ShipmentRow = typeof shipment.$inferSelect;

const scaffold = listScaffold("shipment", shipment, {
  derived: {
    firstEventDate: shipmentSummarySort("firstEventDate"),
    lastEventDate: shipmentSummarySort("lastEventDate"),
    eventSpanHours: shipmentSummarySort("eventSpanHours"),
    eventCount: shipmentSummarySort("eventCount"),
  },
});
export const buildShipmentWhere = (filters: ShipmentFilters = {}) =>
  scaffold.where(filters);
const shipmentRead = {
  media: true,
  bindings: (bind) => {
    const summaries = bind.batch(({ db, rows, context }) =>
      context.has(shipmentEventSummaries)
        ? Promise.resolve(context.get(shipmentEventSummaries))
        : loadShipmentEventSummaries(
            db,
            rows.map((row) => row.id),
          ),
    );
    return [
      summaries.fields(
        shipmentOut.pick({
          firstEventDate: true,
          lastEventDate: true,
          eventSpanHours: true,
          eventSpanLabel: true,
          eventCount: true,
        }),
        (row, loaded) => loaded.get(row.id) ?? shipmentEventSummary([]),
      ),
    ];
  },
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
} satisfies ListReadOptions<ShipmentRow>;
const plan = listReadPlan<ShipmentRow>("shipment", shipmentRead);

export const listShipmentsRead = (
  db: ReaderDb,
  filters: ShipmentFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
  readIntent: ListReadIntent = "page",
) =>
  scaffold.read(
    db,
    { filters, sorts, pagination, projection, readIntent },
    { read: shipmentRead },
  );

const listShipments = completeListReader(shipmentOut, listShipmentsRead);
const reader = createEntityCrud<
  typeof shipment,
  ShipmentRow,
  ShipmentOut,
  ShipmentUpdateData,
  "shipment"
>({
  table: shipment,
  entity: "shipment",
  fetchById: async (db, id) =>
    (
      await unwrapDb(db)
        .select()
        .from(shipment)
        .where(and(eq(shipment.id, id), notDeleted(shipment)))
        .limit(1)
    )[0],
  fromDB: async (db, row) =>
    shipmentOut.parse((await plan.read(db, [row], { kind: "full" }))[0]),
  toUpdate: (data) => buildPartialUpdateValues(data),
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
  update: asActor(update),
  get: (ctx: EntityKernelContext, code: string) =>
    reader.getByShortcode(ctx.db, code),
  list: (
    ctx: EntityKernelContext,
    filters: ShipmentFilters,
    sorts: SortParams[],
    pagination: PaginationParams,
  ) => listShipments(ctx.db, filters, sorts, pagination),
  listRead: (
    ctx: EntityKernelContext,
    filters: ShipmentFilters,
    sorts: SortParams[],
    pagination: PaginationParams,
    projection: ListProjection,
    readIntent: ListReadIntent = "page",
  ) =>
    listShipmentsRead(
      ctx.db,
      filters,
      sorts,
      pagination,
      projection,
      readIntent,
    ),
});

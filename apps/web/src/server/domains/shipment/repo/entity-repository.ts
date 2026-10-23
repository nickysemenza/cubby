import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import {
  shipmentOut,
  type ShipmentFilters,
  type ShipmentOut,
} from "@cubby/schemas/shipment";
import { and, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { shipment, purchase, vendor } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  createEntityReader,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listReadPlan,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";

type ReaderDb = Database | DrizzleTransaction;
type ShipmentRow = typeof shipment.$inferSelect;

const scaffold = listScaffold("shipment", shipment);
export const buildShipmentWhere = (filters: ShipmentFilters = {}) =>
  scaffold.where(filters);
const shipmentRead = {
  media: true,
  bindings: (bind) => [
    bind
      .batch(async ({ db, rows }) => {
        const ids = rows.flatMap((row) =>
          row.purchaseId ? [row.purchaseId] : [],
        );
        const sellers = ids.length
          ? await unwrapDb(db)
              .select({
                purchaseId: purchase.id,
                code: vendor.shortcode,
                name: vendor.name,
              })
              .from(purchase)
              .innerJoin(vendor, eq(purchase.vendorId, vendor.id))
              .where(
                and(
                  inArray(purchase.id, ids),
                  notDeleted(purchase),
                  notDeleted(vendor),
                ),
              )
          : [];
        return new Map(sellers.map((seller) => [seller.purchaseId, seller]));
      })
      .fields(
        shipmentOut.pick({ vendorId: true, vendorName: true }),
        (row, sellers) => {
          const seller = row.purchaseId
            ? sellers.get(row.purchaseId)
            : undefined;
          return {
            vendorId: seller ? parseShortcodeFor("vendor", seller.code) : null,
            vendorName: seller?.name ?? null,
          };
        },
      ),
  ],
  references: {
    purchaseId: {
      kind: "lookup",
      name: "purchaseName",
      missing: "null",
      includeDeleted: true,
    },
    carrierId: {
      kind: "lookup",
      name: "carrierName",
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
) =>
  scaffold.read(
    db,
    { filters, sorts, pagination, projection },
    { read: shipmentRead },
  );

const listShipments = completeListReader(shipmentOut, listShipmentsRead);
const reader = createEntityReader<
  ShipmentRow,
  ShipmentOut,
  "shipment",
  ReaderDb
>({
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
});

export const shipmentRepository = defineRepository("shipment", {
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
  ) => listShipmentsRead(ctx.db, filters, sorts, pagination, projection),
});

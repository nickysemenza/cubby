import {
  ledgerTransferShortcode,
  unsafeLedgerTransferShortcode,
} from "@cubby/schemas/identifiers";
import {
  ledgerTransferCreateInput,
  ledgerTransferFiltersSchema,
  ledgerTransferOut,
  ledgerTransferSortableFields,
  ledgerTransferUpdateData,
} from "@cubby/schemas/ledger-transfer";
import {
  createLedgerTransfer,
  deleteLedgerTransfers,
  getLedgerTransferByShortcode,
  listLedgerTransfers,
  updateLedgerTransfer,
} from "~/server/repo/ledger-transfer";
import {
  createDeleteProcedure,
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter } from "../trpc";

const { list } = createEntityListProcedure({
  schemas: {
    output: ledgerTransferOut,
    filters: ledgerTransferFiltersSchema,
    sort: { sortableFields: ledgerTransferSortableFields, defaultSort: "date" },
  },
  repository: {
    list: (services, filters, sorts, pagination) =>
      listLedgerTransfers(services.db, filters, sorts, pagination),
  },
  entityName: "ledgerTransfer",
});

const procedures = createEntityCrudWithoutListProcedures({
  entityName: "ledgerTransfer",
  schemas: {
    createInput: ledgerTransferCreateInput,
    updateInput: ledgerTransferUpdateData,
    output: ledgerTransferOut,
    idSchema: ledgerTransferShortcode,
  },
  repository: {
    getByShortcode: (services, id) =>
      getLedgerTransferByShortcode(services.db, id),
    create: async (services, data) =>
      (await createLedgerTransfer(services.db, data, services.actorContext))
        .output,
    update: async (services, id, data) =>
      (
        await updateLedgerTransfer(
          services.db,
          unsafeLedgerTransferShortcode(id),
          data,
          services.actorContext,
        )
      ).output,
  },
});

const remove = createDeleteProcedure(
  (services, ids) =>
    deleteLedgerTransfers(
      services.db,
      ids.map(unsafeLedgerTransferShortcode),
      services.actorContext,
    ),
  ledgerTransferShortcode,
);

export const ledgerTransferRouter = createTRPCRouter({
  ...procedures,
  list,
  delete: remove,
});

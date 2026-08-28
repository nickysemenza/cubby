import { ledgerTransferSortableFields } from "@cubby/schemas/ledger-transfer";

import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";

import {
  createLedgerTransfer,
  deleteLedgerTransfers,
  getLedgerTransferByShortcode,
  LEDGER_TRANSFER_DELETE_EDGE_POLICY,
  listLedgerTransfers,
  updateLedgerTransfer,
} from "./ledger-transfer";

export const ledgerTransferEntityAdapter = defineEntityAdapter({
  entity: "ledgerTransfer",
  sideEffects: false,
  sort: { fields: ledgerTransferSortableFields, default: "date" },
  lifecycle: { delete: LEDGER_TRANSFER_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getLedgerTransferByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      listLedgerTransfers(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createLedgerTransfer(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updateLedgerTransfer(ctx.db, id, data, ctx.actorContext),
    delete: async (ctx, ids) => {
      const { detachedImageKeys } = await deleteLedgerTransfers(
        ctx.db,
        ids,
        ctx.actorContext,
      );
      return {
        deletedReferences: entityMutationReferences("ledgerTransfer", ids),
        detachedImageKeys,
      };
    },
  },
});

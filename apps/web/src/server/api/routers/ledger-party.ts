import {
  ledgerPartyShortcode,
  unsafeLedgerPartyShortcode,
} from "@cubby/schemas/identifiers";
import {
  ledgerPartyCreateInput,
  ledgerPartyFiltersSchema,
  ledgerPartyOut,
  ledgerPartySortableFields,
  ledgerPartyUpdateData,
} from "@cubby/schemas/ledger-party";
import { z } from "zod";
import {
  createLedgerParty,
  deleteLedgerParties,
  getLedgerPartyByShortcode,
  listLedgerParties,
  mergeLedgerParties,
  updateLedgerParty,
} from "~/server/repo/ledger-party";
import {
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const { list } = createEntityListProcedure({
  schemas: {
    output: ledgerPartyOut,
    filters: ledgerPartyFiltersSchema,
    sort: { sortableFields: ledgerPartySortableFields, defaultSort: "name" },
  },
  repository: {
    list: (services, filters, sorts, pagination) =>
      listLedgerParties(services.db, filters, sorts, pagination),
  },
  entityName: "ledgerParty",
});

const procedures = createEntityCrudWithoutListProcedures({
  entityName: "ledgerParty",
  schemas: {
    createInput: ledgerPartyCreateInput,
    updateInput: ledgerPartyUpdateData,
    output: ledgerPartyOut,
    idSchema: ledgerPartyShortcode,
  },
  repository: {
    getByShortcode: (services, id) =>
      getLedgerPartyByShortcode(services.db, id),
    create: async (services, data) =>
      (await createLedgerParty(services.db, data, services.actorContext))
        .output,
    update: async (services, id, data) =>
      (
        await updateLedgerParty(
          services.db,
          unsafeLedgerPartyShortcode(id),
          data,
          services.actorContext,
        )
      ).output,
  },
});

const remove = protectedProcedure
  .input(z.object({ ids: z.array(ledgerPartyShortcode).min(1) }))
  .mutation(({ ctx, input }) =>
    deleteLedgerParties(ctx.db, input.ids, ctx.actorContext),
  );
const merge = protectedProcedure
  .input(
    z.object({
      keepId: ledgerPartyShortcode,
      mergeIds: z.array(ledgerPartyShortcode).min(1),
    }),
  )
  .mutation(({ ctx, input }) =>
    mergeLedgerParties(ctx.db, input, ctx.actorContext),
  );

export const ledgerPartyRouter = createTRPCRouter({
  ...procedures,
  list,
  delete: remove,
  merge,
});

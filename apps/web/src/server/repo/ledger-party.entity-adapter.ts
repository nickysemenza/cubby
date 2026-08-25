import {
  ledgerPartyFiltersSchema,
  ledgerPartyOut,
  ledgerPartySortableFields,
} from "@cubby/schemas/ledger-party";
import { z } from "zod";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { defineEntityAdapter } from "~/server/entity-kernel/adapter";
import {
  createLedgerParty,
  deleteLedgerParties,
  getLedgerPartyByShortcode,
  LEDGER_PARTY_DELETE_EDGE_POLICY,
  LEDGER_PARTY_MERGE_EDGE_POLICY,
  listLedgerParties,
  mergeLedgerParties,
  updateLedgerParty,
} from "./ledger-party";

const mergeInput = z.object({
  keepId: ENTITY_BINDINGS.ledgerParty.crud!.idSchema,
  mergeIds: z.array(ENTITY_BINDINGS.ledgerParty.crud!.idSchema).min(1),
});

export const ledgerPartyEntityAdapter = defineEntityAdapter({
  entity: "ledgerParty",
  sideEffects: false,
  filters: ledgerPartyFiltersSchema,
  sort: { fields: ledgerPartySortableFields, default: "name" },
  lifecycle: {
    delete: LEDGER_PARTY_DELETE_EDGE_POLICY,
    merge: LEDGER_PARTY_MERGE_EDGE_POLICY,
  },
  repository: {
    get: (ctx, id) => getLedgerPartyByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      listLedgerParties(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createLedgerParty(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updateLedgerParty(ctx.db, id, data, ctx.actorContext),
    delete: (ctx, ids) => deleteLedgerParties(ctx.db, ids, ctx.actorContext),
  },
  merge: {
    input: mergeInput,
    output: z.object({
      ledgerParty: ledgerPartyOut,
      mergeSummary: z.unknown(),
    }),
    item: (output) => (output as { ledgerParty: unknown }).ledgerParty,
    summary: (output) => (output as { mergeSummary: unknown }).mergeSummary,
    execute: async (ctx, value) => {
      const input = mergeInput.parse(value);
      const { mergeSummary } = await mergeLedgerParties(
        ctx.db,
        input,
        ctx.actorContext,
      );
      const ledgerParty = await getLedgerPartyByShortcode(ctx.db, input.keepId);
      if (!ledgerParty)
        throw new Error("Merged Ledger Party keeper disappeared");
      return {
        output: { ledgerParty, mergeSummary },
        entityId: null,
        detachedImageKeys: [],
      };
    },
  },
});

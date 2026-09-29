import { ledgerPartyOut } from "@cubby/schemas/ledger-party";
import { z } from "zod";

import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";
import {
  asActor,
  defineRepository,
  listOn,
  onDb,
} from "~/server/repo/repository";

import {
  createLedgerParty,
  deleteLedgerParties,
  getLedgerPartyByShortcode,
  LEDGER_PARTY_DELETE_EDGE_POLICY,
  LEDGER_PARTY_MERGE_EDGE_POLICY,
  listLedgerParties,
  listLedgerPartiesRead,
  mergeLedgerParties,
  updateLedgerParty,
} from "./ledger-party";

const mergeInput = z.object({
  keepId: ENTITY_SCHEMA_BINDINGS.ledgerParty.id,
  mergeIds: z.array(ENTITY_SCHEMA_BINDINGS.ledgerParty.id).min(1),
});

const ledgerPartyMergeSummary = z.object({
  deletedIds: z.array(ENTITY_SCHEMA_BINDINGS.ledgerParty.id),
  merged: z.number().int().nonnegative(),
  attributionEdgesRepointed: z.number().int().nonnegative(),
  accountEdgesRepointed: z.number().int().nonnegative(),
  inventoryEdgesRepointed: z.number().int().nonnegative(),
  transferEdgesRepointed: z.number().int().nonnegative(),
  portionEdgesRepointed: z.number().int().nonnegative(),
  foodEntryEdgesRepointed: z.number().int().nonnegative(),
  deviceEdgesRepointed: z.number().int().nonnegative(),
  carriedFields: z.array(z.string()),
});

export const ledgerPartyRepository = defineRepository("ledgerParty", {
  sideEffects: false,
  lifecycle: {
    delete: LEDGER_PARTY_DELETE_EDGE_POLICY,
    merge: LEDGER_PARTY_MERGE_EDGE_POLICY,
  },
  get: onDb(getLedgerPartyByShortcode),
  list: listOn(listLedgerParties),
  listRead: (ctx, filters, sorts, pagination, projection) =>
    listLedgerPartiesRead(ctx.db, filters, sorts, pagination, projection),
  create: asActor(createLedgerParty),
  update: asActor(updateLedgerParty),
  delete: asActor(deleteLedgerParties),
  merge: {
    input: mergeInput,
    output: z.object({
      ledgerParty: ledgerPartyOut,
      mergeSummary: ledgerPartyMergeSummary,
    }),
    item: (output) => output.ledgerParty,
    summary: (output) => output.mergeSummary,
    execute: async (ctx, input) => {
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

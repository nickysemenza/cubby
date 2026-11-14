import { ledgerPartyRawOut as rawLedgerPartyOut } from "@cubby/schemas/entity-contracts/ledgerParty";
import { z } from "zod";

import { ledgerPartySchemaBindings } from "~/entity/generated/entity-schema-bindings.ledgerParty.gen";
import { DECLARED_EDGE_MERGE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import {
  asActor,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";

import {
  createLedgerParty,
  deleteLedgerParties,
  ledgerPartyScaffold,
  readLedgerParty,
  mergeLedgerParties,
  updateLedgerParty,
} from "./ledger-party";

const mergeInput = z.object({
  keepId: ledgerPartySchemaBindings.id,
  mergeIds: z.array(ledgerPartySchemaBindings.id).min(1),
});

const ledgerPartyMergeSummary = z.object({
  deletedIds: z.array(ledgerPartySchemaBindings.id),
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
  schemas: ledgerPartySchemaBindings,
  lifecycle: {
    delete: DECLARED_EDGE_DELETE_POLICIES.ledgerParty,
    merge: DECLARED_EDGE_MERGE_POLICIES.ledgerParty,
  },
  scaffold: ledgerPartyScaffold,
  create: asActor(createLedgerParty),
  update: asActor(updateLedgerParty),
  delete: asActor(deleteLedgerParties),
  merge: {
    input: mergeInput,
    output: z.object({
      ledgerParty: rawLedgerPartyOut,
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
      const ledgerParty = await readLedgerParty(ctx.db, input.keepId);
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

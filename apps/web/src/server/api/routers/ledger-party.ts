import { ledgerPartyShortcode } from "@cubby/schemas/identifiers";
import { z } from "zod";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { ENTITY_KERNEL_BINDINGS } from "~/server/entity-kernel/registry";
import { mergeLedgerParties } from "~/server/repo/ledger-party";
import { createEntityCompatibilityProcedures } from "../entity-compatibility";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const procedures = createEntityCompatibilityProcedures(
  ENTITY_KERNEL_BINDINGS.ledgerParty,
  ENTITY_BINDINGS.ledgerParty.crud,
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
  merge,
});

import {
  previewOperationInputSchema,
  previewOperationSchema,
} from "@cubby/schemas/entity-integrity";
import {
  createTRPCRouter,
  protectedProcedure,
  strictOutput,
} from "~/server/api/trpc";
import { previewOperation } from "./entity-integrity-preview";

export const entityIntegrityRouter = createTRPCRouter({
  /**
   * What an attach or detach would do, without doing it. Read-only; the
   * mutation remains authoritative and rechecks inside its transaction.
   */
  previewOperation: protectedProcedure
    .input(previewOperationInputSchema)
    .output(strictOutput(previewOperationSchema))
    .query(({ ctx, input }) => previewOperation(ctx.db, input, new Date())),
});

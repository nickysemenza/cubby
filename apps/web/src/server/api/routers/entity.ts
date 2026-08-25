import { executeEntity } from "~/server/entity-kernel";
import {
  entityMutationCommandSchema,
  entityMutationResultSchema,
} from "~/server/entity-kernel/contracts";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

export const entityRouter = createTRPCRouter({
  mutate: protectedProcedure
    .input(entityMutationCommandSchema)
    .output(strictOutput(entityMutationResultSchema))
    .mutation(({ ctx, input }) => executeEntity(ctx, input)),
});

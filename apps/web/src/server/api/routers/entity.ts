import { executeEntity } from "~/server/entity-kernel";
import {
  entityMutationCommandSchema,
  entityMutationResultSchema,
  entityQueryCommandSchema,
  entityQueryResultSchema,
} from "~/server/entity-kernel/contracts";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

export const entityRouter = createTRPCRouter({
  query: protectedProcedure
    .input(entityQueryCommandSchema)
    .output(strictOutput(entityQueryResultSchema))
    .query(({ ctx, input }) => executeEntity(ctx, input)),
  mutate: protectedProcedure
    .input(entityMutationCommandSchema)
    .output(strictOutput(entityMutationResultSchema))
    .mutation(({ ctx, input }) => executeEntity(ctx, input)),
});

import {
  recipeFlowArtifactSchema,
  recipeFlowGenerateInputSchema,
  recipeFlowGetInputSchema,
  recipeFlowStateSchema,
} from "@cubby/schemas/recipe-flow";
import {
  generateRecipeFlow,
  getRecipeFlowState,
} from "~/server/services/recipe-flow/recipe-flow.service";
import { protectedProcedure } from "../../trpc";

const getFlow = protectedProcedure
  .input(recipeFlowGetInputSchema)
  .output(recipeFlowStateSchema)
  .query(async ({ ctx, input }) => {
    return await getRecipeFlowState(ctx.db, input.id);
  });

const generateFlow = protectedProcedure
  .input(recipeFlowGenerateInputSchema)
  .output(recipeFlowArtifactSchema)
  .mutation(async ({ ctx, input }) => {
    return await generateRecipeFlow(ctx.db, input);
  });

export const recipeFlowProcedures = {
  getFlow,
  generateFlow,
};

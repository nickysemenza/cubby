import {
  recipeFlowArtifactSchema,
  recipeFlowGenerateInputSchema,
  recipeFlowGetInputSchema,
  recipeFlowStateSchema,
} from "@cubby/schemas/recipe-flow";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  generateRecipeFlow,
  getRecipeFlowState,
} from "~/server/services/recipe-flow/recipe-flow.service";
import { protectedProcedure, strictOutput } from "../../trpc";

const resolveRecipeEntityId = async (
  db: Parameters<typeof resolveOrThrow>[0],
  shortcode: string,
) => {
  return resolveOrThrow(db, "recipe", shortcode);
};

const getFlow = protectedProcedure
  .input(recipeFlowGetInputSchema)
  .output(strictOutput(recipeFlowStateSchema))
  .query(async ({ ctx, input }) => {
    return await getRecipeFlowState(
      ctx.db,
      await resolveRecipeEntityId(ctx.db, input.id),
    );
  });

const generateFlow = protectedProcedure
  .input(recipeFlowGenerateInputSchema)
  .output(strictOutput(recipeFlowArtifactSchema))
  .mutation(async ({ ctx, input }) => {
    return await generateRecipeFlow(ctx.db, {
      ...input,
      id: await resolveRecipeEntityId(ctx.db, input.id),
    });
  });

export const recipeFlowProcedures = {
  getFlow,
  generateFlow,
};

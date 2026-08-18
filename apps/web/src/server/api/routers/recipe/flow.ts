import {
  recipeFlowArtifactSchema,
  recipeFlowGenerateInputSchema,
  recipeFlowGetInputSchema,
  recipeFlowStateSchema,
} from "@cubby/schemas/recipe-flow";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  generateRecipeFlow,
  getRecipeFlowState,
} from "~/server/services/recipe-flow/recipe-flow.service";
import { protectedProcedure, strictOutput } from "../../trpc";

const recipeShortcodes = bindShortcodeResolver("recipe");

const getFlow = protectedProcedure
  .input(recipeFlowGetInputSchema)
  .output(strictOutput(recipeFlowStateSchema))
  .query(async ({ ctx, input }) => {
    return await getRecipeFlowState(
      ctx.db,
      await recipeShortcodes.one(ctx.db, input.id),
    );
  });

const generateFlow = protectedProcedure
  .input(recipeFlowGenerateInputSchema)
  .output(strictOutput(recipeFlowArtifactSchema))
  .mutation(async ({ ctx, input }) => {
    return await generateRecipeFlow(ctx.db, {
      ...input,
      id: await recipeShortcodes.one(ctx.db, input.id),
    });
  });

export const recipeFlowProcedures = {
  getFlow,
  generateFlow,
};

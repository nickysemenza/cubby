import { unsafeRecipeId } from "@cubby/schemas/identifiers";
import {
  recipeFlowArtifactSchema,
  recipeFlowGenerateInputSchema,
  recipeFlowGetInputSchema,
  recipeFlowStateSchema,
} from "@cubby/schemas/recipe-flow";
import { createAppError } from "~/server/errors/app-error";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import {
  generateRecipeFlow,
  getRecipeFlowState,
} from "~/server/services/recipe-flow/recipe-flow.service";
import { protectedProcedure, strictOutput } from "../../trpc";

const resolveRecipeEntityId = async (
  db: Parameters<typeof resolveLiveShortcode>[0],
  shortcode: string,
) => {
  const id = await resolveLiveShortcode(db, shortcode, "recipe");
  if (!id) {
    throw createAppError("RECIPE_NOT_FOUND", `Recipe ${shortcode} not found`);
  }
  return unsafeRecipeId(id);
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

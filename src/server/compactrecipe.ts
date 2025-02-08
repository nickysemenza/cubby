import { type db } from "./db";
import { type ParsedCompactRecipe } from "~/codec/codec";
import { findOrCreateIngredient } from "./api/routers/ingredients";
import { RecipeSource } from "@prisma/client";

export const upsertRecipeFromCompact = async (
  recipe: ParsedCompactRecipe,
  prismaClient: typeof db,
) => {
  return await prismaClient.$transaction(async (tx) => {
    const newRecipe = await tx.recipe.upsert({
      where: { name: recipe.name },
      update: {},
      create: {
        name: recipe.name,
        SourceData: recipe.meta?.url ?? null,
        SourceType: recipe.meta?.url ? RecipeSource.Website : null,
      },
      include: { sections: { include: { ingredients: true } } },
    });
    // delete all existing sections and sectioningredients (in reverse order)
    await tx.recipeSectionIngredient.deleteMany({
      where: {
        recipeSectionId: {
          in: newRecipe.sections.map((section) => section.id),
        },
      },
    });
    await tx.recipeSection.deleteMany({
      where: { recipeId: newRecipe.id },
    });
    for (const section of recipe.sections) {
      const newSection = await tx.recipeSection.create({
        data: {
          recipeId: newRecipe.id,
          name: null,
          instructions: section.instructions.map((text) => {
            return { text };
          }),
        },
      });

      for (const ingredient of section.ingredients) {
        const newIngredient = await findOrCreateIngredient(tx, ingredient.name);

        const amounts: PrismaJson.Amount[] = ingredient.amounts;
        await tx.recipeSectionIngredient.create({
          data: {
            recipeSectionId: newSection.id,
            ingredientId: newIngredient.id,
            amounts,
          },
        });
      }
    }
    return { id: newRecipe.id };
  });
};

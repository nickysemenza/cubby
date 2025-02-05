import { type db } from "./db";
import { ItemType } from "@prisma/client";
import { type ParsedCompactRecipe } from "~/codec/codec";
import { findOrCreateItem } from "./api/routers/item";

export const insertRecipeFromCompact = async (
  recipe: ParsedCompactRecipe,
  prismaClient: typeof db,
) => {
  return await prismaClient.$transaction(async (tx) => {
    const newRecipe = await tx.recipe.create({
      data: {
        name: recipe.name,
      },
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
        const newIngredient = await findOrCreateItem(
          tx,
          ingredient.name,
          ItemType.Ingredient,
        );

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

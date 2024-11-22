import { type db } from "./db";
import { ItemType } from "@prisma/client";
import { type ParsedCompactRecipe } from "~/codec/codec";

export const insertRecipeFromCompact = async (
  recipe: ParsedCompactRecipe,
  prismaClient: typeof db,
) => {
  return await prismaClient.$transaction(async (tx) => {
    const newRecipe = await tx.recipe.create({
      data: { name: recipe.name },
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
        const newIngredient = await tx.item.upsert({
          where: {
            name_type: { name: ingredient.name, type: ItemType.Ingredient },
          },
          create: { name: ingredient.name, type: ItemType.Ingredient },
          update: {},
        });
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
    return newRecipe.id;
  });
};

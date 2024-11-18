import { createSeedClient } from "@snaplet/seed";
import { copycat } from "@snaplet/copycat";
import { faker } from "@faker-js/faker";

const main = async () => {
  const seed = await createSeedClient();

  // Truncate all tables in the database
  await seed.$resetDatabase();

  // Seed the database with 10 recipe
  const { recipe } = await seed.recipe((x) =>
    x(10, { deletedAt: null, name: () => faker.food.dish() }),
  );
  for (const r of recipe) {
    const { recipeSection } = await seed.recipeSection(
      (x) =>
        x(2, { deletedAt: null, name: () => "section " + faker.lorem.word() }),
      {
        connect: { recipe: [r] },
      },
    );
    const { ingredient } = await seed.ingredient((x) =>
      x(50, { name: () => faker.food.ingredient() }),
    );
    for (const rs of recipeSection) {
      for (let i = 0; i < 3; i++) {
        await seed.recipeSectionIngredient((x) => x(1, { deletedAt: null }), {
          connect: {
            recipeSection: [rs],
            ingredient: [copycat.oneOf(`${rs.name}${i}`, ingredient)],
          },
        });
      }
    }
  }
  console.log("Database seeded successfully!");
  process.exit();
};

void main();

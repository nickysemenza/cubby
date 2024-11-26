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
        x(2, {
          deletedAt: null,
          name: () => "section " + faker.lorem.word(),
          instructions: () => [{ instruction: faker.lorem.sentence() }],
        }),
      {
        connect: { recipe: [r] },
      },
    );
    const { item } = await seed.item((x) =>
      x(50, { name: () => faker.food.ingredient() }),
    );
    for (const rs of recipeSection) {
      for (let i = 0; i < 3; i++) {
        const amount: PrismaJson.Amount = {
          value: faker.number.int({ min: 1, max: 10 }),
          unit: faker.helpers.arrayElement([
            "cup",
            "tbsp",
            "tsp",
            "oz",
            "lb",
            "g",
            "kg",
          ]),
        };
        await seed.recipeSectionIngredient(
          (x) => x(1, { deletedAt: null, amounts: [amount] }),
          {
            connect: {
              recipeSection: [rs],
              recipeSectionIngredient: [copycat.oneOf(`${rs.name}${i}`, item)],
            },
          },
        );
      }
    }
  }
  console.log("Database seeded successfully!");

  process.exit();
};

void main();

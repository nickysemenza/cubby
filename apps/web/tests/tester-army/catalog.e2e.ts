import { expect } from "e2e";
import { z } from "zod";
import { test, outcome } from "./journey.fixtures";

test("product rename survives reopening and preserves notes", async ({
  data,
  agent,
  screen,
}) => {
  const { product } = data.world.rename;
  await data.open(`/products/${product.id}`);
  await agent.act('Rename this product to "Synthetic Renamed Lamp" and save.');
  outcome(await data.fields("product", product.id, ["name", "notes"]), {
    name: "Synthetic Renamed Lamp",
    notes: "Preserve these synthetic notes",
  });
  await data.open(`/products/${product.id}`);
  await expect(
    screen.getByRole("heading", "Synthetic Renamed Lamp"),
  ).toBeVisible();
});

test("project status changes persist", async ({ data, agent }) => {
  const { project } = data.world.status;
  await data.open(`/projects/${project.id}`);
  await agent.act("Set this project's status to Done and save the change.");
  outcome(await data.fields("project", project.id, ["status"]), {
    status: "done",
  });
});

test("marking a wish purchased persists", async ({ data, agent }) => {
  const { wish } = data.world.wish;
  await data.open(`/wishes/${wish.id}`);
  await agent.act(
    "Use Mark purchased for this wish and confirm. Finish with the purchase recorded.",
  );
  const saved = z
    .object({ acquiredAt: z.union([z.string().min(1), z.date()]) })
    .parse(await data.fields("wish", wish.id, ["acquiredAt"]));
  outcome({ acquired: Boolean(saved.acquiredAt) }, { acquired: true });
});

test("editing tags preserves existing tags", async ({ data, agent }) => {
  const { product } = data.world.tags;
  await data.open(`/products/${product.id}`);
  await agent.act(
    'Open Edit Product. Add "synthetic-new-tag" in Tags using Add value, preserving the existing tags. Leave the editor open with the new tag committed.',
  );
  await agent.act(
    "Save changes. Finish on the product detail page showing the heading Synthetic Tagged Kettle.",
  );
  const tags = z
    .object({ tags: z.array(z.string()) })
    .parse(await data.fields("product", product.id, ["tags"])).tags;
  outcome(
    { count: tags.length, tags: tags.sort() },
    {
      count: 3,
      tags: ["synthetic-new-tag", "synthetic-old-tag", "synthetic-shelf"],
    },
  );
});

test("label nutrition editing preserves serving size and other nutrients", async ({
  data,
  agent,
}) => {
  const { product } = data.world.nutrition;
  await data.open(`/products/${product.id}`);
  await agent.act(
    "Open Edit Product, open Nutrition, and set Calories (kcal) to 150. Preserve serving size and protein. Leave the editor open with Calories showing 150.",
  );
  await agent.act(
    "Save changes. Finish on the product detail page showing the heading Synthetic Labeled Crackers.",
  );
  outcome(await data.fields("product", product.id, ["labelNutrition"]), {
    labelNutrition: {
      servingGrams: 30,
      nutrients: { kcal: 150, protein: 3 },
      source: "Synthetic label",
    },
  });
});

test("adding an identifier preserves product identity", async ({
  data,
  agent,
}) => {
  const { product } = data.world.identifier;
  await data.open(`/products/${product.id}`);
  await agent.act(
    'Open Edit Product and add an external ID row. Enter Source "synthetic-shop" and leave the editor open.',
  );
  await agent.act(
    'Choose Kind "asin" and enter Identifier "B0SYNTH001" in the new external ID row. Leave the editor open with those values.',
  );
  await agent.act(
    "Save changes. Finish on the product detail page showing the heading Synthetic Catalog Whisk.",
  );
  outcome(await data.fields("product", product.id, ["name", "externalIds"]), {
    name: "Synthetic Catalog Whisk",
    externalIds: [
      { source: "synthetic-shop", kind: "asin", externalId: "B0SYNTH001" },
    ],
  });
});

test("account source alias editing preserves account identity", async ({
  data,
  agent,
}) => {
  const { account } = data.world.alias;
  await data.open(`/financial-accounts/${account.id}`);
  await agent.act(
    "Open Edit Account and add a new Source aliases row. Leave the new row visible in the editor.",
  );
  await agent.act(
    'Set the new alias Source to "synthetic-bank" and Alias to "SYN CHK 1234". Leave External account id empty and keep the editor open.',
  );
  await agent.act(
    "Save changes. Finish on the account detail page showing the heading Synthetic Alias Account.",
  );
  outcome(
    await data.fields("financialAccount", account.id, [
      "name",
      "sourceAliases",
    ]),
    {
      name: "Synthetic Alias Account",
      sourceAliases: [
        {
          source: "synthetic-bank",
          alias: "SYN CHK 1234",
          externalAccountId: null,
        },
      ],
    },
  );
});

test("transaction source reference editing preserves its amount", async ({
  data,
  agent,
}) => {
  const { transaction } = data.world.reference;
  await data.open(`/financial-transactions/${transaction.id}`);
  await agent.act(
    "Open Edit Transaction and add a new Source refs row. Leave the new row visible in the editor.",
  );
  await agent.act(
    'Enter Source "synthetic-bank" and External ID "SYN-REF-1" in the new source ref row. Leave the editor open with those values.',
  );
  await agent.act(
    "Save changes. Finish on the transaction detail page showing Synthetic Ref Merchant.",
  );
  outcome(
    await data.fields("financialTransaction", transaction.id, [
      "amount",
      "sourceRefs",
    ]),
    {
      amount: 21,
      sourceRefs: [
        {
          source: "synthetic-bank",
          externalId: "SYN-REF-1",
        },
      ],
    },
  );
});

test("recipe ingredient editing preserves its instruction", async ({
  data,
  agent,
}) => {
  const { recipe } = data.world.recipe;
  await data.open(`/recipes/${recipe.id}`);
  await agent.act(
    "Change the flour ingredient amount from 250 g to 300 g and save, preserving the recipe instructions.",
  );
  outcome(await data.fields("recipe", recipe.id, ["sections"]), {
    sections: [
      {
        ingredients: [{ amounts: [{ value: 300, unit: "g" }] }],
        instructions: [{ instruction: "Whisk the flour with water." }],
      },
    ],
  });
});

test("delete preview writes nothing and confirmation cascades only to children", async ({
  data,
  agent,
  screen,
}) => {
  const { project, task, child } = data.world.deletion;
  await data.open(`/tasks/${task.id}`);
  await agent.act(
    "Open the Delete action and stop at the impact preview. Do not confirm deletion.",
  );
  await expect(screen.getByRole("dialog")).toBeVisible();
  outcome(await data.fields("task", task.id, ["name"]), {
    name: "Synthetic doomed task",
  });
  outcome(await data.fields("task", child.id, ["name"]), {
    name: "Synthetic dependent checklist item",
  });
  await agent.act("Confirm the deletion in the open impact preview.");
  outcome(
    {
      task: await data.detail("task", task.id),
      child: await data.detail("task", child.id),
    },
    { task: null, child: null },
  );
  outcome(await data.fields("project", project.id, ["name"]), {
    name: "Synthetic Delete Project",
  });
});

import { z } from "zod";
import { expect } from "e2e";
import { test, outcome, readFields } from "./journey.fixtures";

const expenseRow = z.object({
  purchaseId: z.string().nullable(),
  name: z.string(),
  cost: z.number().nullable(),
});

test("receiving purchase stock and adding inventory preserve existing units", async ({
  data,
  agent,
  screen,
}) => {
  const { location, product, purchase, expense } = data.world.receive;
  await data.open(`/purchases/${purchase.id}`);
  await screen.getByRole("button", "More actions").click();
  await screen.getByRole("button", "Receive into inventory...").click();
  await expect(
    screen.getByRole("button", "Additional units arrived"),
  ).toBeVisible();
  await agent.act(
    'In the open receive dialog, choose Additional units arrived, location "Synthetic Journey Shelf", and Quantity to add 3. Finish when Quantity to add shows 3 and Add to count is enabled; do not click Add to count.',
  );
  await expect(screen.getByRole("spinbutton", "Quantity to add")).toHaveValue(
    "3",
  );
  await screen.getByRole("button", "Add to count").click();
  await expect(screen.getByRole("button", "Add to count")).toBeHidden();
  const stocks = z
    .object({ inventoryEntry: z.array(z.unknown()) })
    .parse(await data.detail("product", product.id)).inventoryEntry;
  const quantities = stocks.map(
    (row) =>
      z
        .object({
          amount: z.object({ value: z.number(), unit: z.literal("each") }),
        })
        .parse(readFields(row, ["amount"])).amount.value,
  );
  outcome(
    { units: quantities.reduce((sum, value) => sum + value, 0) },
    { units: 5 },
  );
  outcome(
    {
      correctLocation: stocks.every(
        (row) =>
          z.object({ location: z.object({ id: z.string() }) }).parse(row)
            .location.id === location.id,
      ),
    },
    { correctLocation: true },
  );
  await data.open(`/products/${product.id}`);
  await agent.act(
    'Open Add to inventory and set four additional units at "Synthetic Journey Shelf". Leave the dialog open before saving.',
  );
  await screen
    .getByRole("dialog")
    .getByRole("button", { name: /^Add \d+ products? to inventory$/ })
    .click();
  await expect(screen.getByRole("dialog")).toBeHidden();
  const added = z
    .object({ inventoryEntry: z.array(z.unknown()) })
    .parse(await data.detail("product", product.id)).inventoryEntry;
  const amounts = added.map(
    (row) =>
      z
        .object({ amount: z.object({ value: z.number() }) })
        .parse(readFields(row, ["amount"])).amount.value,
  );
  outcome(
    { units: amounts.reduce((sum, value) => sum + value, 0) },
    { units: 9 },
  );
  outcome(
    await data.fields("expense", expense.id, ["cost", "productQuantity"]),
    { cost: 30, productQuantity: 3 },
  );
});

test("recording a sale preserves the product and signed amount", async ({
  data,
  agent,
}) => {
  const { product } = data.world.sale;
  await data.open(`/products/${product.id}`);
  await agent.act(
    'Open More actions and choose Record sale. Record a sale named "Synthetic chair sale" for -12.50, dated October 10, 2026, with Trade "Appliances & Furniture", and save.',
  );
  const sales = (await data.list("expense"))
    .map((row) =>
      readFields(row, [
        "name",
        "cost",
        "costType",
        "lineKind",
        "trade",
        "projectId",
        "productId",
      ]),
    )
    .filter((row) => row.name === "Synthetic chair sale");
  outcome(
    { count: sales.length, sales },
    {
      count: 1,
      sales: [
        {
          name: "Synthetic chair sale",
          cost: -12.5,
          costType: "tools",
          lineKind: "principal",
          trade: "appliances",
          projectId: null,
          productId: product.id,
        },
      ],
    },
  );
  outcome(await data.fields("product", product.id, ["name"]), {
    name: "Synthetic Saleable Chair",
  });
});

test("expense splitting refuses missing and mismatched costs then conserves each cent", async ({
  data,
  agent,
  screen,
}) => {
  const { purchase, expense, unknown } = data.world.split;
  const readParts = async (includeUnknown = false) =>
    (await data.list("expense"))
      .map((row) =>
        expenseRow.parse(readFields(row, ["purchaseId", "name", "cost"])),
      )
      .filter(
        (row) =>
          row.purchaseId === purchase.id &&
          (includeUnknown || row.name !== "Synthetic costless"),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  await data.open(`/expenses/${expense.id}`);
  await agent.act(
    'Open More actions and choose Split. Set both receipt roles to Item or service. Set part one to "Synthetic part one" costing 6.00 and part two to "Synthetic part two" costing 4.00. Leave the dialog open without correcting the one-cent mismatch.',
  );
  await expect(screen.getByRole("button", "Split into 2")).toBeDisabled();
  outcome(await data.fields("expense", expense.id, ["cost"]), { cost: 10.01 });
  const refused = await readParts();
  outcome(
    { count: refused.length, rows: refused },
    {
      count: 1,
      rows: [
        { name: "Synthetic splittable", cost: 10.01, purchaseId: purchase.id },
      ],
    },
  );
  await agent.act(
    "Set Part 2 cost to 4.01. Leave the split dialog open with that value.",
  );
  await expect(screen.getByRole("button", "Split into 2")).toBeEnabled();
  await screen.getByRole("button", "Split into 2").click();
  await expect(screen.getByRole("dialog", { name: /^Split / })).toBeHidden();
  const rows = await readParts();
  outcome(
    {
      count: rows.length,
      cents: rows.reduce(
        (sum, row) => sum + Math.round((row.cost ?? 0) * 100),
        0,
      ),
      parts: rows
        .map((row) => ({
          name: row.name,
          cents: Math.round((row.cost ?? 0) * 100),
        }))
        .sort((a, b) => a.cents - b.cents),
    },
    {
      count: 2,
      cents: 1001,
      parts: [
        { name: "Synthetic part two", cents: 401 },
        { name: "Synthetic part one", cents: 600 },
      ],
    },
  );
  const beforeUnknown = await readParts(true);
  await data.open(`/expenses/${unknown.id}`);
  await screen.getByRole("button", "More actions").click();
  await screen.getByRole("button", "Split...").click();
  await expect(screen.getByRole("spinbutton", "Part 1 cost")).toHaveValue("");
  await expect(screen.getByRole("spinbutton", "Part 2 cost")).toHaveValue("");
  await expect(screen.getByRole("button", "Split into 2")).toBeDisabled();
  outcome(await data.fields("expense", unknown.id, ["cost"]), { cost: null });
  const afterUnknown = await readParts(true);
  outcome(
    { count: afterUnknown.length, rows: afterUnknown },
    { count: beforeUnknown.length, rows: beforeUnknown },
  );
});

test("moving an expense requires confirmation and attaching a product preserves money", async ({
  data,
  agent,
  screen,
}) => {
  const { origin, target, expense, product } = data.world.attach;
  await data.open(`/purchases/${target.id}#work`);
  await agent.act(
    'Open More actions and Attach existing expenses. Select only "Synthetic movable expense". Leave the attachment dialog open before Attach 1.',
  );
  await screen.getByRole("button", "Attach 1").click();
  await expect(screen.getByRole("button", "Confirm: attach 1")).toBeVisible();
  await expect(screen.getByRole("dialog")).toBeVisible();
  outcome(await data.fields("expense", expense.id, ["purchaseId", "cost"]), {
    purchaseId: origin.id,
    cost: 12,
  });
  await screen.getByRole("button", "Confirm: attach 1").click();
  await expect(
    screen.getByRole("dialog", { name: /^Attach expenses to / }),
  ).toBeHidden();
  outcome(await data.fields("expense", expense.id, ["purchaseId", "cost"]), {
    purchaseId: target.id,
    cost: 12,
  });
  await agent.act(
    'Open Attach products and select only "Synthetic Attachable Sieve". Leave the product attachment dialog open before Attach 1.',
  );
  await screen
    .getByRole("dialog", { name: /^Attach products to / })
    .getByRole("button", "Attach 1")
    .click();
  await expect(
    screen.getByRole("dialog", { name: /^Attach products to / }),
  ).toBeHidden();
  const purchase = z
    .object({ items: z.array(z.object({ productId: z.string() })) })
    .parse(
      await data.operation("entity.relation", {
        entity: "purchase",
        relation: "products",
        id: target.id,
        offset: 0,
        limit: 100,
      }),
    );
  outcome(
    { linked: purchase.items.some((item) => item.productId === product.id) },
    { linked: true },
  );
  outcome(await data.fields("expense", expense.id, ["cost"]), { cost: 12 });
});

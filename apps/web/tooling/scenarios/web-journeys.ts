import type { KernelContext } from "./context";
import { createEntity } from "../factories/create";
import { taxonomyShortcode } from "../product-category-fixtures";

/** Synthetic starting records, cloned into each journey's disposable world. */
export async function seedWebJourneyWorld(context: KernelContext) {
  const rename = await (async () => {
    const product = await createEntity(context, "product", {
      name: "Synthetic Journey Lamp",
      notes: "Preserve these synthetic notes",
    });

    return { product };
  })();
  const status = await (async () => {
    const project = await createEntity(context, "project", {
      name: "Synthetic Status Project",
      status: "planning",
    });

    return { project };
  })();
  const wish = await (async () => {
    const wish = await createEntity(context, "wish", {
      name: "Synthetic Wish Lantern",
    });

    return { wish };
  })();
  const tags = await (async () => {
    const product = await createEntity(context, "product", {
      name: "Synthetic Tagged Kettle",
      tags: ["synthetic-old-tag", "synthetic-shelf"],
    });

    return { product };
  })();
  const nutrition = await (async () => {
    const product = await createEntity(context, "product", {
      name: "Synthetic Labeled Crackers",
      categoryId: taxonomyShortcode("food"),
      labelNutrition: {
        servingGrams: 30,
        nutrients: { kcal: 120, protein: 3 },
        source: "Synthetic label",
      },
    });

    return { product };
  })();
  const identifier = await (async () => {
    const product = await createEntity(context, "product", {
      name: "Synthetic Catalog Whisk",
    });

    return { product };
  })();
  const alias = await (async () => {
    const account = await createEntity(context, "financialAccount", {
      name: "Synthetic Alias Account",
    });

    return { account };
  })();
  const reference = await (async () => {
    const account = await createEntity(context, "financialAccount", {
      name: "Synthetic Ref Account",
    });
    const transaction = await createEntity(context, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 21,
      merchant: "Synthetic Ref Merchant",
      transactionDate: "2026-06-05",
      postedDate: "2026-06-05",
    });

    return { account, transaction };
  })();
  const recipe = await (async () => {
    const ingredient = await createEntity(context, "ingredient", {
      name: "Synthetic Line Flour",
    });
    const recipe = await createEntity(context, "recipe", {
      name: "Synthetic Line Pancakes",
      meta: null,
      sections: [
        {
          ingredients: [
            {
              type: "ingredient",
              ingredientId: ingredient.id,
              recipeId: null,
              amounts: [{ value: 250, unit: "g" }],
            },
          ],
          instructions: [{ instruction: "Whisk the flour with water." }],
        },
      ],
    });

    return { ingredient, recipe };
  })();
  const deletion = await (async () => {
    const project = await createEntity(context, "project", {
      name: "Synthetic Delete Project",
    });
    const task = await createEntity(context, "task", {
      name: "Synthetic doomed task",
      projectId: project.id,
      trade: "other",
    });
    const child = await createEntity(context, "task", {
      name: "Synthetic dependent checklist item",
      parentTaskId: task.id,
      trade: "other",
    });

    return { project, task, child };
  })();
  const receive = await (async () => {
    const vendor = await createEntity(context, "vendor", {
      name: "Synthetic Receive Vendor",
    });
    const location = await createEntity(context, "location", {
      name: "Synthetic Journey Shelf",
    });
    const product = await createEntity(context, "product", {
      name: "Synthetic Receivable Widget",
    });
    await createEntity(context, "inventory", {
      productId: product.id,
      locationId: location.id,
      amount: { value: 2, unit: "each" },
    });
    const purchase = await createEntity(context, "purchase", {
      vendorId: vendor.id,
      orderId: "SYN-RECEIVE-1",
    });
    const expense = await createEntity(context, "expense", {
      name: "Synthetic widget order line",
      cost: 30,
      productId: product.id,
      productQuantity: 3,
      purchaseId: purchase.id,
      trade: "other",
    });

    return { vendor, location, product, purchase, expense };
  })();
  const sale = await (async () => {
    const product = await createEntity(context, "product", {
      name: "Synthetic Saleable Chair",
    });

    return { product };
  })();
  const split = await (async () => {
    const vendor = await createEntity(context, "vendor", {
      name: "Synthetic Split Vendor",
    });
    const purchase = await createEntity(context, "purchase", {
      vendorId: vendor.id,
      orderId: "SYN-SPLIT-1",
    });
    const expense = await createEntity(context, "expense", {
      name: "Synthetic splittable",
      cost: 10.01,
      purchaseId: purchase.id,
      trade: "other",
    });

    const unknown = await createEntity(context, "expense", {
      name: "Synthetic costless",
      cost: null,
      purchaseId: purchase.id,
      trade: "other",
    });
    return { vendor, purchase, expense, unknown };
  })();
  const attach = await (async () => {
    const vendor = await createEntity(context, "vendor", {
      name: "Synthetic Attach Vendor",
    });
    const origin = await createEntity(context, "purchase", {
      vendorId: vendor.id,
      orderId: "SYN-ATTACH-ORIGIN",
    });
    const target = await createEntity(context, "purchase", {
      vendorId: vendor.id,
      orderId: "SYN-ATTACH-TARGET",
    });
    const expense = await createEntity(context, "expense", {
      name: "Synthetic movable expense",
      cost: 12,
      purchaseId: origin.id,
      trade: "other",
    });
    const product = await createEntity(context, "product", {
      name: "Synthetic Attachable Sieve",
    });

    return { vendor, origin, target, expense, product };
  })();
  const board = await (async () => {
    const project = await createEntity(context, "project", {
      name: "Synthetic Destination Project",
    });
    const sibling = await createEntity(context, "task", {
      name: "Synthetic lane card",
      projectId: project.id,
      trade: "other",
    });
    const task = await createEntity(context, "task", {
      name: "Synthetic inbox card",
      projectId: null,
      trade: "other",
    });

    return { project, sibling, task };
  })();
  const claim = await (async () => {
    const expense = await createEntity(context, "expense", {
      name: "Synthetic claim expense",
      cost: 10,
      trade: "other",
      sourceClaims: [
        {
          source: "synthetic-provider",
          providerId: "synthetic-row-1",
          normalizedEvidence: {
            amount: 10,
            occurredOn: "2026-08-20",
            description: "Synthetic claim evidence",
            context: null,
            disambiguator: null,
          },
          reconciliation: { decision: "amounts_match" },
        },
      ],
    });

    return { expense };
  })();
  async function picker(width: number) {
    const vendor = await createEntity(context, "vendor", {
      name: `Synthetic Picker Vendor ${width}`,
    });
    const original = await createEntity(context, "project", {
      name: `Synthetic Original Project ${width}`,
    });
    const replacement = await createEntity(context, "project", {
      name: `Synthetic Replacement Project ${width}`,
    });
    const purchase = await createEntity(context, "purchase", {
      vendorId: vendor.id,
      defaultProjectId: original.id,
      orderId: `SYN-PICKER-${width}`,
    });

    return { vendor, original, replacement, purchase };
  }
  return {
    rename,
    status,
    wish,
    tags,
    nutrition,
    identifier,
    alias,
    reference,
    recipe,
    deletion,
    receive,
    sale,
    split,
    attach,
    board,
    claim,
    pickers: { desktop: await picker(1280), phone: await picker(390) },
  };
}

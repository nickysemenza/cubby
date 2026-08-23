import { inventoryCreatePayloadData } from "@cubby/schemas/inventory";
import { locationCreateInput } from "@cubby/schemas/location";
import { productCreateInput } from "@cubby/schemas/product";
import { type TaskStatus, taskCreateInput } from "@cubby/schemas/project";
import { expect, type Page } from "@playwright/test";

type CreatedEntity = { id: string };

/**
 * Seed prerequisites through the existing protected tRPC procedures, with the
 * same parsed inputs as the app. This deliberately creates no test endpoint:
 * browser tests still own the interaction and mutation they exercise, while
 * these helpers only create unrelated prerequisite records.
 */
async function createFixture<T extends CreatedEntity>(
  page: Page,
  procedure: string,
  input: unknown,
): Promise<T> {
  const response = await page.request.post(`/api/trpc/${procedure}`, {
    headers: { "x-trpc-source": "e2e-fixture" },
    data: { json: input },
  });
  const responseBody = (await response.json()) as {
    result?: { data?: T | { json?: T } };
  };
  expect(response, `fixture ${procedure} failed`).toBeOK();
  const data = responseBody.result?.data;
  const output =
    data && typeof data === "object" && "json" in data ? data.json : data;
  if (!output || typeof output !== "object" || !("id" in output)) {
    throw new Error(`Fixture ${procedure} returned no entity id`);
  }
  return output as T;
}

const productFixtureInput = (name: string, manufacturer: string) =>
  productCreateInput.parse({
    name,
    aliases: [],
    tags: [],
    upc: null,
    manufacturer,
    model: null,
    notes: null,
    expectedQuantity: null,
    ingredientId: null,
  });

export const seedTaskPrerequisite = (
  page: Page,
  opts: { name: string; dueDate?: string; status?: TaskStatus },
) =>
  createFixture(
    page,
    "task.create",
    taskCreateInput.parse({
      name: opts.name,
      trade: "other",
      dueDate: opts.dueDate,
      status: opts.status,
    }),
  );

export const seedLocationPrerequisite = (page: Page, name: string) =>
  createFixture(
    page,
    "location.create",
    locationCreateInput.parse({
      name,
      aliases: [],
      tags: [],
      type: "room",
      parentId: null,
    }),
  );

export const seedProductPrerequisite = (
  page: Page,
  opts: { name: string; manufacturer?: string },
) =>
  createFixture(
    page,
    "product.create",
    productFixtureInput(opts.name, opts.manufacturer ?? "E2E fixture"),
  );

export const seedInventoryPrerequisites = (
  page: Page,
  opts: {
    locationName: string;
    products: Array<{ name: string; quantity: number; unit: string }>;
  },
) =>
  (async () => {
    const location = await seedLocationPrerequisite(page, opts.locationName);
    const products = [];
    for (const product of opts.products) {
      const created = await seedProductPrerequisite(page, {
        name: product.name,
      });
      await createFixture(
        page,
        "inventory.create",
        inventoryCreatePayloadData.parse({
          productId: created.id,
          locationId: location.id,
          amount: { value: product.quantity, unit: product.unit },
        }),
      );
      products.push(created);
    }
    return { products, location };
  })();

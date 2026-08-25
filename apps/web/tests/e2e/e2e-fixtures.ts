import { inventoryCreatePayloadData } from "@cubby/schemas/inventory";
import { locationCreateInput } from "@cubby/schemas/location";
import { productCreateInput } from "@cubby/schemas/product";
import { type TaskStatus, taskCreateInput } from "@cubby/schemas/project";
import type { Page } from "@playwright/test";
import type {
  EntityKernelEntity,
  EntityMutationCommand,
  EntityMutationResult,
} from "~/server/entity-kernel/contracts";

type CreatedEntity = { id: string };

async function createFixture<T extends CreatedEntity>(
  page: Page,
  entity: EntityKernelEntity,
  input: unknown,
): Promise<T> {
  if (page.url() === "about:blank") {
    try {
      await page.goto("/settings", { waitUntil: "commit" });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ERR_ABORTED")) {
        throw error;
      }
    }
  }
  await page.waitForFunction(
    () =>
      typeof (window as typeof window & { __cubbyEntityMutation?: unknown })
        .__cubbyEntityMutation === "function",
  );
  const result = await page.evaluate(
    async (command: EntityMutationCommand) =>
      await (
        window as typeof window & {
          __cubbyEntityMutation: (
            command: EntityMutationCommand,
          ) => Promise<EntityMutationResult>;
        }
      ).__cubbyEntityMutation(command),
    { action: "create", entity, data: input } as EntityMutationCommand,
  );
  const output = result.action === "create" ? result.item : null;
  if (!output || typeof output !== "object" || !("id" in output)) {
    throw new Error(`Fixture ${entity}.create returned no entity id`);
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
    "task",
    taskCreateInput.parse({
      name: opts.name,
      trade: "other",
      dueDate: opts.dueDate,
      status: opts.status,
    }),
  );

export const seedLocationPrerequisite = (
  page: Page,
  name: string,
  opts: { parentId?: string } = {},
) =>
  createFixture(
    page,
    "location",
    locationCreateInput.parse({
      name,
      aliases: [],
      tags: [],
      type: "room",
      parentId: opts.parentId ?? null,
    }),
  );

export const seedProductPrerequisite = (
  page: Page,
  opts: { name: string; manufacturer?: string },
) =>
  createFixture(
    page,
    "product",
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
        "inventory",
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

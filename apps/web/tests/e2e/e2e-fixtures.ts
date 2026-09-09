import { importRecipesSchema } from "@cubby/schemas/import-recipe";
import { upsertCookbook } from "~/server/repo/cookbook";
import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { inventoryCreatePayloadData } from "@cubby/schemas/inventory";
import { locationCreateInput } from "@cubby/schemas/location";
import { productCreateInput } from "@cubby/schemas/product";
import { type TaskStatus, taskCreateInput } from "@cubby/schemas/project";
import { testUserId } from "@cubby/schemas/testing";
import type { Page } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";

import { Database } from "~/server/db";
import * as schema from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import {
  type EntityBrowserMutationCommand,
  entityBrowserMutationCommandSchema,
} from "~/server/entity-kernel/contracts";
import { createUploadedImageRecord } from "~/server/repo/image";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

type CreatedEntity = { id: string };
const fixtureSessionSchema = z.object({
  user: z.object({ id: z.string().min(1) }).optional(),
});
const createdEntitySchema = z.object({ id: z.string().min(1) });
type FixtureUserId = ReturnType<typeof testUserId>;

let fixtureDb: Database | undefined;
const fixtureUserIds = new WeakMap<object, Promise<FixtureUserId>>();

function getFixtureDb(): Database {
  if (fixtureDb) return fixtureDb;
  const connectionString =
    process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "E2E_DATABASE_URL is required for server-side Playwright fixtures",
    );
  }
  const pool = new Pool({ connectionString, max: 2, allowExitOnIdle: true });
  const client = drizzle(pool, { schema });
  fixtureDb = new Database(() => ({
    client,
    withConnection: (run) => run(client),
  }));
  return fixtureDb;
}

function fixtureUserId(page: Page): Promise<FixtureUserId> {
  const context = page.context();
  const existing = fixtureUserIds.get(context);
  if (existing) return existing;

  const pending = (async () => {
    const response = await page.request.get("/api/auth/get-session");
    if (!response.ok()) {
      throw new Error(`Fixture session lookup failed: ${response.status()}`);
    }
    const session = fixtureSessionSchema.parse(await response.json());
    const userId = session.user?.id;
    if (!userId) {
      throw new Error("Fixture session has no authenticated user id");
    }
    return testUserId(userId);
  })();
  fixtureUserIds.set(context, pending);
  return pending;
}

async function createFixture<Input>(
  page: Page,
  entity: Extract<EntityBrowserMutationCommand, { action: "create" }>["entity"],
  input: Input,
): Promise<CreatedEntity> {
  const db = getFixtureDb();
  const context = requireActor(
    createTestRequestContext(db, {
      auth: { userId: await fixtureUserId(page) },
    }),
  );
  const command = entityBrowserMutationCommandSchema.parse({
    action: "create",
    entity,
    data: input,
  });
  const result = await executeEntity(context, command);
  if (result.action !== "create") {
    throw new Error(`Fixture ${entity}.create returned the wrong action`);
  }
  return createdEntitySchema.parse(result.item);
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

export const seedFinancialAccountPrerequisite = (page: Page, name: string) =>
  createFixture(
    page,
    "financialAccount",
    financialAccountCreateInput.parse({
      name,
      identity: { kind: "cash" },
      provisional: false,
      sourceAliases: [],
      ledgerPartyId: null,
      notes: null,
    }),
  );

export const seedImagePrerequisite = async (name: string) => {
  const created = await createUploadedImageRecord(getFixtureDb(), {
    key: `e2e-${name}`,
    filename: `${name}.png`,
    contentType: "image/png",
    size: 100,
  });
  return { id: created.shortcode };
};

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

export async function seedCookbookSourcePrerequisite(page: Page, name: string) {
  const db = getFixtureDb();
  const context = requireActor(
    createTestRequestContext(db, {
      auth: { userId: await fixtureUserId(page) },
    }),
  );
  const result = await upsertCookbook(
    db,
    {
      name,
      sourceLabel: "photo-fixture.epub",
      rawJson: importRecipesSchema.parse([
        {
          meta: { title: `${name} carrots` },
          sections: [
            {
              ingredients: ["2 carrots"],
              instructions: ["Roast the carrots."],
            },
          ],
          image: {
            kind: "epub",
            path: "OEBPS/images/hero.png",
            mime: "image/png",
          },
        },
        {
          meta: { title: `${name} potatoes` },
          sections: [
            {
              ingredients: ["2 potatoes"],
              instructions: ["Roast the potatoes."],
            },
          ],
          image: {
            kind: "epub",
            path: "OEBPS/images/hero.png",
            mime: "image/png",
          },
        },
      ]),
    },
    context.actorContext,
  );
  return result.output;
}

export async function seedStaplePlanningPrerequisite(page: Page, name: string) {
  const ingredient = await createFixture(page, "ingredient", { name });
  const recipe = await createFixture(page, "recipe", {
    name: `${name} recipe`,
    meta: null,
    sections: [
      {
        ingredients: [
          {
            type: "ingredient",
            ingredientId: ingredient.id,
            recipeId: null,
            amounts: [{ value: 10, unit: "g" }],
          },
        ],
        instructions: [{ instruction: "Mix." }],
      },
    ],
  });
  await createFixture(page, "meal", {
    date: "2026-09-09",
    name: `${name} meal`,
    recipes: [{ recipeId: recipe.id, scale: 1 }],
  });
  return { ingredient, recipe };
}

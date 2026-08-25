import { unsafeUserId } from "@cubby/schemas/identifiers";
import { inventoryCreatePayloadData } from "@cubby/schemas/inventory";
import { locationCreateInput } from "@cubby/schemas/location";
import { productCreateInput } from "@cubby/schemas/product";
import { type TaskStatus, taskCreateInput } from "@cubby/schemas/project";
import type { Page } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createTestTRPCContext } from "~/server/api/trpc";
import type { Database } from "~/server/db";
import * as schema from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import {
  type EntityBrowserMutationCommand,
  entityBrowserMutationCommandSchema,
} from "~/server/entity-kernel/contracts";
import { requireActor } from "~/server/request-context";

type CreatedEntity = { id: string };

let fixtureDb: Database | undefined;

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
  fixtureDb = drizzle(pool, { schema }) as unknown as Database;
  return fixtureDb;
}

async function fixtureUserId(page: Page) {
  const response = await page.request.get("/api/auth/get-session");
  if (!response.ok()) {
    throw new Error(`Fixture session lookup failed: ${response.status()}`);
  }
  const session = (await response.json()) as {
    user?: { id?: string };
  };
  const userId = session.user?.id;
  if (!userId) throw new Error("Fixture session has no authenticated user id");
  return unsafeUserId(userId);
}

async function createFixture(
  page: Page,
  entity: Extract<EntityBrowserMutationCommand, { action: "create" }>["entity"],
  input: unknown,
): Promise<CreatedEntity> {
  const db = getFixtureDb();
  const context = requireActor(
    createTestTRPCContext(db, {
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
  const output = result.item;
  if (!output || typeof output !== "object" || !("id" in output)) {
    throw new Error(`Fixture ${entity}.create returned no entity id`);
  }
  return output;
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

import "./build-constants";

import { taxonomyShortcode } from "../../tooling/product-category-fixtures";

import { upsertCookbook } from "~/server/repo/cookbook";
import {
  makeCookbookExtraction,
  makeCookbookRecipe,
} from "~/server/repo/repo.fixtures";
import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { inventoryCreatePayloadData } from "@cubby/schemas/inventory";
import { locationCreateInput } from "@cubby/schemas/location";
import { ledgerPartyCreateInput } from "@cubby/schemas/ledger-party";
import { saveMealFoodInput } from "@cubby/schemas/meal";
import { plantingCreateInput } from "@cubby/schemas/planting";
import { productCreateInput } from "@cubby/schemas/product";
import { productCategoryCreateInput } from "@cubby/schemas/product-category";
import { type TaskStatus, taskCreateInput } from "@cubby/schemas/project";
import { testUserId } from "@cubby/schemas/testing";
import {
  parseEntityId,
  parseShortcodeFor,
  type ImageShortcode,
} from "@cubby/schemas/identifiers";
import type { Page } from "@playwright/test";
import { and, count, eq, isNull, sql } from "drizzle-orm";
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
import {
  attachExistingImageToEntity,
  createUploadedImageRecord,
} from "~/server/repo/image";
import { saveMealFood } from "~/server/repo/meal/food";
import { getDb } from "~/server/repo/database-helpers";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import { householdDaysFromNow, householdLocalDate } from "~/lib/household-date";

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

const productFixtureInput = (
  name: string,
  manufacturer: string,
  categoryId?: string,
) =>
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
    categoryId: categoryId ?? null,
  });

/** Seed a synthetic taxonomy node when a browser flow needs a stable route. */
export const seedProductCategoryPrerequisite = (
  page: Page,
  opts: {
    name: string;
    parentId?: string | null;
    aliases?: string[];
    description?: string | null;
  },
) =>
  createFixture(
    page,
    "productCategory",
    productCategoryCreateInput.parse({
      name: opts.name,
      aliases: opts.aliases ?? [],
      description: opts.description ?? null,
      parentId: opts.parentId ?? null,
      sortOrder: 0,
      feature: null,
    }),
  );

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

export const seedPlantingPrerequisite = (
  page: Page,
  opts: {
    ingredientId: string;
    locationId?: string;
    status?: string;
    taskId?: string;
  },
) =>
  createFixture(
    page,
    "planting",
    plantingCreateInput.parse({
      ingredientId: opts.ingredientId,
      locationId: opts.locationId ?? null,
      status: opts.status,
      taskId: opts.taskId,
    }),
  );

export const seedProductPrerequisite = (
  page: Page,
  opts: { name: string; manufacturer?: string; categoryId?: string },
) =>
  createFixture(
    page,
    "product",
    productFixtureInput(
      opts.name,
      opts.manufacturer ?? "E2E fixture",
      opts.categoryId,
    ),
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
  return { id: parseShortcodeFor("image", created.shortcode) };
};

/** Attach a synthetic uploaded image through the same existing-image workflow. */
export const attachProductImagePrerequisite = async (
  page: Page,
  imageId: ImageShortcode,
  productId: string,
  purpose: "item" | "label",
) =>
  attachExistingImageToEntity(
    getFixtureDb(),
    { imageId, targetId: productId, purpose },
    requireActor(
      createTestRequestContext(getFixtureDb(), {
        auth: { userId: await fixtureUserId(page) },
      }),
    ).actorContext,
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

export async function seedToolFlowPrerequisite(
  page: Page,
  groups: ReadonlyArray<{
    locationName: string;
    productNames: readonly string[];
  }>,
) {
  const seededGroups = [];
  for (const group of groups) {
    const location = await seedLocationPrerequisite(page, group.locationName);
    const products = [];
    for (const name of group.productNames) {
      const product = await createFixture(
        page,
        "product",
        productFixtureInput(
          name,
          "Flow fixture maker",
          taxonomyShortcode("tools"),
        ),
      );
      await createFixture(
        page,
        "inventory",
        inventoryCreatePayloadData.parse({
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        }),
      );
      products.push(product);
    }
    seededGroups.push({ ...group, location, products });
  }
  return seededGroups;
}

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
      rawJson: makeCookbookExtraction([
        makeCookbookRecipe(`${name} carrots`, ["2 carrots"], {
          id: "001.0001",
          steps: ["Roast the carrots."],
          photos: [{ path: "OEBPS/images/hero.png", mime: "image/png" }],
        }),
        makeCookbookRecipe(`${name} potatoes`, ["2 potatoes"], {
          id: "001.0020",
          steps: ["Roast the potatoes."],
          photos: [{ path: "OEBPS/images/hero.png", mime: "image/png" }],
        }),
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

export const seedIngredientPrerequisite = (page: Page, name: string) =>
  createFixture(page, "ingredient", { name });

export async function seedNutritionPrerequisite(
  page: Page,
  name: string,
  options: { missingCalories?: boolean } = {},
) {
  const measured = await createFixture(page, "ingredient", {
    name: `${name} measured`,
  });
  const incomplete = await createFixture(page, "ingredient", {
    name: `${name} incomplete`,
  });
  for (const [ingredient, mappings] of [
    [
      measured,
      [
        { value: 100, unit: "kcal" },
        { value: 10, unit: "g protein" },
        { value: 0, unit: "mg sodium" },
        { value: 50, unit: "mg calcium" },
      ],
    ],
    [incomplete, options.missingCalories ? [] : [{ value: 50, unit: "kcal" }]],
  ] as const) {
    await createFixture(
      page,
      "product",
      productCreateInput.parse({
        ...productFixtureInput(
          `${ingredient.id} nutrition source`,
          "E2E fixture",
        ),
        ingredientId: ingredient.id,
        unitMappings: mappings.map((b) => ({
          a: { value: 100, unit: "g" },
          b,
          source: "E2E fixture",
        })),
      }),
    );
  }
  const recipe = await createFixture(page, "recipe", {
    name,
    servings: 2,
    yield: { value: 300, unit: "g" },
    meta: null,
    sections: [
      {
        ingredients: [
          {
            type: "ingredient",
            ingredientId: measured.id,
            recipeId: null,
            amounts: [{ value: 100, upperValue: 200, unit: "g" }],
          },
          {
            type: "ingredient",
            ingredientId: incomplete.id,
            recipeId: null,
            amounts: [{ value: 100, unit: "g" }],
          },
        ],
        instructions: [{ instruction: "Combine." }],
      },
    ],
  });
  const db = getFixtureDb();
  const row = await getDb(db).query.recipe.findFirst({
    where: eq(schema.recipe.shortcode, recipe.id),
  });
  if (!row) throw new Error("Nutrition recipe fixture missing");
  const context = createTestRequestContext(db, {
    auth: { userId: await fixtureUserId(page) },
  });
  await context.services.recipeCosting.recompute([row.id]);
  const meal = await createFixture(page, "meal", {
    date: "2026-09-09",
    name: `${name} meal`,
    recipes: [{ recipeId: recipe.id, scale: 1 }],
  });
  return { recipe, measured, incomplete, meal };
}

export async function seedMealNutritionPrerequisite(
  page: Page,
  name: string,
  options: { seedProductPortion?: boolean } = {},
) {
  const member = await createFixture(
    page,
    "ledgerParty",
    ledgerPartyCreateInput.parse({
      name: `${name} member`,
      kind: "member",
    }),
  );
  const guest = await createFixture(
    page,
    "ledgerParty",
    ledgerPartyCreateInput.parse({
      name: `${name} guest`,
      kind: "guest",
    }),
  );
  const ingredient = await createFixture(page, "ingredient", {
    name: `${name} snack ingredient`,
  });
  const product = await createFixture(
    page,
    "product",
    productCreateInput.parse({
      ...productFixtureInput(`${name} snack`, "E2E fixture"),
      ingredientId: ingredient.id,
      labelNutrition: {
        servingGrams: 30,
        nutrients: { kcal: 120, protein: 3, carbs: 20, fat: 4 },
        source: "E2E package label",
      },
    }),
  );
  const today = householdLocalDate();
  const futureDate = householdDaysFromNow(2);
  const inlineDate = householdDaysFromNow(3);
  const meal = await createFixture(page, "meal", {
    date: today,
    name: `${name} meal`,
    mealType: "snack",
    mealKind: "other",
    recipes: [],
  });
  const futureMeal = await createFixture(page, "meal", {
    date: futureDate,
    name: `${name} future meal`,
    mealType: "snack",
    mealKind: "other",
    recipes: [],
  });
  const db = getFixtureDb();
  const context = requireActor(
    createTestRequestContext(db, {
      auth: { userId: await fixtureUserId(page) },
    }),
  );
  await saveMealFood(
    db,
    saveMealFoodInput.parse({
      mealId: meal.id,
      ledgerPartyId: guest.id,
      sourceKind: "manual",
      name: `${name} manual snack`,
      grams: null,
      nutrients: { kcal: 250, protein: 20, carbs: 0 },
    }),
    context.actorContext,
  );
  if (options.seedProductPortion) {
    await saveMealFood(
      db,
      saveMealFoodInput.parse({
        mealId: meal.id,
        ledgerPartyId: member.id,
        sourceKind: "product",
        productId: product.id,
        grams: 45,
      }),
      context.actorContext,
    );
  }
  return {
    member,
    guest,
    product,
    ingredient,
    meal,
    futureMeal,
    today,
    futureDate,
    inlineDate,
    manualFoodName: `${name} manual snack`,
  };
}

export async function clearNutritionCachePrerequisite(shortcode: string) {
  await getDb(getFixtureDb()).execute(sql`UPDATE ${schema.recipe}
    SET "totals" = NULL, "totalsComputedAt" = NULL
    WHERE ${schema.recipe.shortcode} = ${shortcode}`);
}

export const seedVendorDisplayPrerequisite = (page: Page, name: string) =>
  createFixture(page, "vendor", {
    name,
    website: "https://example.com",
    orderUrlTemplate: "https://example.com/orders/{orderId}",
    notes: `${name} notes`,
  });

export async function seedRecordListDisplayPrerequisite(
  page: Page,
  name: string,
) {
  const vendor = await seedVendorDisplayPrerequisite(page, `${name} vendor`);
  const product = await seedProductPrerequisite(page, {
    name: `${name} product`,
  });
  const location = await seedLocationPrerequisite(page, `${name} room`);
  const child = await seedLocationPrerequisite(page, `${name} shelf`, {
    parentId: location.id,
  });
  await createFixture(page, "inventory", {
    productId: product.id,
    locationId: location.id,
    amount: { value: 2, unit: "each" },
  });
  const orderId = `${name} order`;
  const purchase = await createFixture(page, "purchase", {
    vendorId: vendor.id,
    orderId,
    date: "2026-09-09",
    statedTotal: 12.34,
    notes: `${name} purchase notes`,
  });
  const expense = await createFixture(page, "expense", {
    name: `${name} expense`,
    cost: 12.34,
    date: "2026-09-09",
    costType: "materials",
    trade: "other",
    productId: product.id,
    productQuantity: 2,
    purchaseId: purchase.id,
    notes: `${name} expense notes`,
  });
  return { vendor, product, location, child, purchase, expense, orderId };
}

export async function seedPurchaseHeicAttachment(page: Page, name: string) {
  const vendor = await seedVendorDisplayPrerequisite(page, `${name} vendor`);
  const purchase = await createFixture(page, "purchase", {
    vendorId: vendor.id,
    orderId: `${name} order`,
    date: "2026-09-16",
  });
  const db = getDb(getFixtureDb());
  const owner = await db.query.purchase.findFirst({
    where: eq(schema.purchase.shortcode, purchase.id),
    columns: { id: true },
  });
  if (!owner) throw new Error("Seeded purchase did not resolve");
  const attached = await createUploadedImageRecord(getFixtureDb(), {
    key: `e2e-${name}-${crypto.randomUUID()}.heic`,
    filename: `${name}.heic`,
    contentType: "image/heic",
    size: 100,
  });
  await db.insert(schema.purchaseImage).values({
    purchaseId: owner.id,
    imageId: attached.id,
  });
  return { purchase, filename: attached.filename };
}

export async function seedRelationshipReviewPrerequisite(
  page: Page,
  name: string,
) {
  // Separate date windows keep earlier browser cases out of the top-three candidates.
  const [projectCount] = await getDb(getFixtureDb())
    .select({ value: count() })
    .from(schema.project);
  const year = 2100 + (projectCount?.value ?? 0);
  const current = await createFixture(page, "project", {
    name: `${name} current`,
    startDate: `${year}-05-01`,
    endDate: `${year}-05-31`,
  });
  const target = await createFixture(page, "project", {
    name: `${name} suggested`,
    startDate: `${year}-05-01`,
    endDate: `${year}-05-31`,
  });
  const product = await seedProductPrerequisite(page, {
    name: `${name} switch`,
  });
  await createFixture(page, "expense", {
    name: `${name} supporting expense`,
    projectId: target.id,
    productId: product.id,
    date: `${year}-05-02`,
    cost: 10,
    trade: "electrical",
    costType: "materials",
  });
  const expense = await createFixture(page, "expense", {
    name: `${name} reviewed expense`,
    projectId: current.id,
    productId: product.id,
    date: `${year}-05-10`,
    cost: 20,
    trade: "electrical",
    costType: "materials",
  });
  return { current, target, product, expense };
}

export async function seedPlacementReviewPrerequisite(
  page: Page,
  name: string,
) {
  const existingUnknown = await getDb(getFixtureDb()).query.location.findFirst({
    where: and(
      eq(schema.location.name, "Unknown"),
      isNull(schema.location.deletedAt),
    ),
  });
  const unknown = existingUnknown
    ? { id: existingUnknown.shortcode }
    : await seedLocationPrerequisite(page, "Unknown");
  const target = await seedLocationPrerequisite(page, `${name} workshop`);
  const product = await seedProductPrerequisite(page, { name });
  const destination = await createFixture(
    page,
    "inventory",
    inventoryCreatePayloadData.parse({
      productId: product.id,
      locationId: target.id,
      amount: { value: 1, unit: "each" },
    }),
  );
  const source = await createFixture(
    page,
    "inventory",
    inventoryCreatePayloadData.parse({
      productId: product.id,
      locationId: unknown.id,
      amount: { value: 1, unit: "each" },
    }),
  );
  return { source, destination, target };
}

/** One catalog garment, two independently owned quantities in different places. */
export async function seedWardrobePrerequisites(page: Page, name: string) {
  const owner = await createFixture(
    page,
    "ledgerParty",
    ledgerPartyCreateInput.parse({ name: `${name} owner`, kind: "member" }),
  );
  const other = await createFixture(
    page,
    "ledgerParty",
    ledgerPartyCreateInput.parse({ name: `${name} other`, kind: "guest" }),
  );
  const location = await seedLocationPrerequisite(page, `${name} drawer`);
  const otherLocation = await seedLocationPrerequisite(
    page,
    `${name} other drawer`,
  );
  const product = await createFixture(
    page,
    "product",
    productCreateInput.parse({
      ...productFixtureInput(
        `${name} shirt`,
        "Fixture",
        taxonomyShortcode("apparel"),
      ),
    }),
  );
  const entry = await createFixture(
    page,
    "inventory",
    inventoryCreatePayloadData.parse({
      productId: product.id,
      locationId: location.id,
      amount: { value: 3, unit: "each" },
      ownershipMode: "person",
      ownerLedgerPartyId: owner.id,
    }),
  );
  await createFixture(
    page,
    "inventory",
    inventoryCreatePayloadData.parse({
      productId: product.id,
      locationId: otherLocation.id,
      amount: { value: 7, unit: "each" },
      ownershipMode: "person",
      ownerLedgerPartyId: other.id,
    }),
  );
  return { owner, other, location, otherLocation, product, entry };
}

/** Durable failed history only; this fixture never dispatches or calls AI. */
export async function seedActivityHistory(name: string) {
  const db = getFixtureDb();
  const source = await createUploadedImageRecord(db, {
    key: `tests/${crypto.randomUUID()}.png`,
    filename: `${name}.png`,
    contentType: "image/png",
    size: 100,
  });
  const database = getDb(db);
  const [job] = await database
    .insert(schema.imageProcessingJob)
    .values({
      imageId: parseEntityId("image", source.id),
      kind: "describe_image",
      sourceContentHash: "a".repeat(64),
      processorRevision: 1,
      state: "failed",
      attempts: 1,
      lastError: "Synthetic provider failure",
    })
    .returning();
  if (!job) throw new Error("Activity fixture job not created");
  await database.insert(schema.imageProcessingAttempt).values({
    id: crypto.randomUUID(),
    jobId: job.id,
    number: 1,
    state: "failed",
    executor: {
      kind: "cloud",
      deviceId: null,
      name: "Test provider",
      platform: "cloud",
      appVersion: null,
      osVersion: null,
    },
    diagnostics: {
      provider: "test",
      model: "synthetic-vision",
      inputAvailability: "historical input unavailable",
    },
    result: { status: "failed", reason: "Synthetic provider failure" },
    completedAt: new Date(),
  });
  await database.insert(schema.imageProcessingEvent).values({
    jobId: job.id,
    eventKey: "test-completed",
    event: "attempt.completed",
    details: { status: "failed" },
  });
  return {
    imageId: source.shortcode,
    runId: job.publicId,
    filename: source.filename,
  };
}

export async function seedInheritancePrerequisite(page: Page, name: string) {
  const project = await createFixture(page, "project", {
    name: `${name} project`,
    defaultTrade: "building",
  });
  const vendor = await seedVendorDisplayPrerequisite(page, `${name} vendor`);
  const purchase = await createFixture(page, "purchase", {
    vendorId: vendor.id,
    date: "2026-09-20",
    defaultProjectId: project.id,
  });
  const expense = await createFixture(page, "expense", {
    name: `${name} item`,
    date: "2026-09-20",
    purchaseId: purchase.id,
    projectId: project.id,
    cost: 10,
    costType: "materials",
  });
  const charge = await createFixture(page, "expense", {
    name: `${name} tax`,
    date: "2026-09-20",
    purchaseId: purchase.id,
    cost: 1,
    costType: "services",
    lineKind: "tax",
  });
  return { project, purchase, expense, charge };
}

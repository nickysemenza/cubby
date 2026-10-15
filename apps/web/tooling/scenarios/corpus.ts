import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { entitySchema } from "@cubby/schemas/entity-core";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { upsertCookbookInput } from "@cubby/schemas/import-recipe";
import { plainDate } from "@cubby/schemas/base-entity";
import { saveMealFoodInput } from "@cubby/schemas/meal";
import { z } from "zod";
import type { Pool } from "pg";
import * as schema from "~/server/db/schema";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { upsertCookbook } from "~/server/domains/cookbook/repo/cookbook";
import { createRecipe } from "~/server/domains/recipe/repo/crud";
import { saveMealFood } from "~/server/domains/meal/repo/food";
import {
  householdDateTime,
  householdLocalDate,
  shiftPlainDate,
} from "~/lib/household-date";
import {
  attachExistingImageToEntity,
  createUploadedImageRecord,
} from "~/server/domains/image/repo/image";
import {
  startPhotoInventoryRun,
  markRunFailed,
} from "~/server/domains/purchase-import/repo/run-service";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { seedBaseWorld, BASE_HOME_SHORTCODE } from "../factories/base-world";
import {
  buildEntity,
  type CreatableEntity,
  type EntityOverrides,
} from "../factories/build";
import { createEntity } from "../factories/create";
import { DEV_FAKER_SEED, fakerFromSeed } from "../factories/faker";
import { syntheticBundle } from "../cookbook-bundle-fixture";
import { assertDevDatabaseUrl, LOCAL_FIXTURE_VERSION } from "../dev/state";
import {
  assertSimulatorAdminUrl,
  assertSimulatorDatabaseName,
} from "../sim-db-guard";
import { testServiceConfig } from "../test-service-config";
import { taxonomyShortcode } from "../product-category-fixtures";
import {
  buildKernelContext,
  buildScenarioDatabase,
  type CreatedEntity,
  type KernelContext,
} from "./context";

const HOUSEHOLD_VERSION = LOCAL_FIXTURE_VERSION;
const coverageRow = z.object({
  entity: entitySchema,
  count: z.number().int().nonnegative(),
  status: z.enum(["seeded", "external", "missing"]),
  reason: z.string().nullable(),
});
const storageOptions = z.object({
  storageOrigin: z.string().url(),
  bucket: z.string().min(1),
  keyPrefix: z.string().min(1),
  referenceDate: plainDate.optional(),
});
export type HouseholdStorage = z.infer<typeof storageOptions>;

/** Only the guarded dev/native targets or an IntegreSQL test lease may seed. */
function assertHouseholdDatabase(pool: Pool) {
  const url = new URL(pool.options.connectionString ?? "");
  const name = url.pathname.slice(1);
  if (name.startsWith("cubby_dev")) {
    assertDevDatabaseUrl(url.href);
    return;
  }
  if (name.startsWith("cubby_sim_")) {
    assertSimulatorDatabaseName(name);
    const admin = new URL(url.href);
    admin.pathname = "/postgres";
    assertSimulatorAdminUrl(admin.href);
    return;
  }
  const config = testServiceConfig();
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== config.host ||
    Number(url.port || 5432) !== config.port ||
    !/^integresql_test_[0-9a-f]{40}_[0-9]+$/u.test(name)
  )
    throw new Error(
      "Connected household seeding requires a guarded dev/native database or an IntegreSQL test lease",
    );
}

/** New declared tables must have actual rows; read-only external catalogs report
 * their owning runtime rather than pretending to create a database record. */
export async function readHouseholdCoverage(
  pool: Pool,
): Promise<z.infer<typeof coverageRow>[]> {
  const rows: z.infer<typeof coverageRow>[] = [];
  for (const entity of entitySchema.options) {
    const declaration = entityManifest[entity];
    const table = declaration.dbTable;
    if (!table) {
      rows.push(
        coverageRow.parse({
          entity,
          count: 0,
          status: entity === "usda-food" ? "external" : "missing",
          reason:
            entity === "usda-food"
              ? "Synthetic USDA release is seeded by the dev/E2E Worker, not PostgreSQL."
              : "No household seed case for this declared external entity.",
        }),
      );
      continue;
    }
    // Table identifiers come only from the generated manifest, never caller input.
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "${table.replaceAll('"', '""')}"${declaration.softDelete ? ' WHERE "deletedAt" IS NULL' : ""}`,
    );
    const count = result.rows[0]?.count ?? 0;
    rows.push(
      coverageRow.parse({
        entity,
        count,
        status: count ? "seeded" : "missing",
        reason: count
          ? null
          : "No household seed case for this declared entity.",
      }),
    );
  }
  return rows;
}

/** Shared dev/screenshot/native exploration household. Scenario states and edges
 * are curated; only non-asserted filler uses the isolated seeded Faker instance.
 * A failed or outdated seed refuses retries until its ephemeral database resets. */
export async function seedCorpus(
  pool: Pool,
  userId: string,
  storage: HouseholdStorage,
): Promise<void> {
  assertHouseholdDatabase(pool);
  const options = storageOptions.parse(storage);
  const origin = new URL(options.storageOrigin);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(origin.hostname))
    throw new Error("Household image storage must use a local test/dev origin");
  await pool.query(
    "CREATE TABLE IF NOT EXISTS cubby_household_fixture (version integer PRIMARY KEY, state text NOT NULL)",
  );
  const marker = await pool.query<{ version: number; state: string }>(
    "SELECT version, state FROM cubby_household_fixture",
  );
  if (marker.rows.length) {
    if (
      marker.rows.length === 1 &&
      marker.rows[0]?.version === HOUSEHOLD_VERSION &&
      marker.rows[0].state === "complete"
    )
      return;
    throw new Error(
      "Partial or outdated synthetic household; reset the ephemeral database before reseeding",
    );
  }
  await pool.query(
    "INSERT INTO cubby_household_fixture VALUES ($1, 'seeding')",
    [HOUSEHOLD_VERSION],
  );
  try {
    await seedConnectedHousehold(pool, userId, options);
    const coverage = await readHouseholdCoverage(pool);
    console.log(
      `[household] ${coverage.map((row) => `${row.entity}:${row.status === "external" ? row.reason : row.count}`).join(", ")}`,
    );
    const missing = coverage.filter((row) => row.status === "missing");
    if (missing.length)
      throw new Error(
        `Unsupported household seed cases: ${missing.map((row) => row.entity).join(", ")}`,
      );
    await pool.query(
      "UPDATE cubby_household_fixture SET state = 'complete' WHERE version = $1",
      [HOUSEHOLD_VERSION],
    );
  } catch (error) {
    // The initial seeding marker already refuses retries. Preserve the original
    // domain/storage failure if recording the failed state also loses its connection.
    await pool
      .query(
        "UPDATE cubby_household_fixture SET state = 'failed' WHERE version = $1",
        [HOUSEHOLD_VERSION],
      )
      .catch(() => {});
    throw error;
  }
}

async function seedConnectedHousehold(
  pool: Pool,
  userId: string,
  storage: HouseholdStorage,
) {
  const faker = fakerFromSeed(DEV_FAKER_SEED);
  const referenceDate = storage.referenceDate ?? householdLocalDate();
  const day = (offset: number) => shiftPlainDate(referenceDate, offset);
  const db = buildScenarioDatabase(pool);
  const context = buildKernelContext(db, testUserId(userId));
  const create = <E extends CreatableEntity>(
    entity: E,
    overrides: EntityOverrides<E> = {},
  ) => createEntity(context, entity, overrides, { faker });
  await seedBaseWorld(db.clientForRepository());
  const existingMember = await pool.query<{ shortcode: string }>(
    'SELECT shortcode FROM "LedgerParty" WHERE "userId" = $1 AND kind = \'member\' AND "deletedAt" IS NULL LIMIT 1',
    [userId],
  );
  const member =
    existingMember.rows[0] ??
    (await insertWithShortcode(db, "ledgerParty", {
      name: "Cedar Household Member",
      kind: "member",
      userId: testUserId(userId),
    }));
  const memberCode = parseShortcodeFor("ledgerParty", member.shortcode);
  const guest = await create("ledgerParty", {
    name: "Rowan Guest",
    kind: "guest",
    notes: "Invented guest for shared meals and expenses.",
  });
  // User-backed member identity includes an auth row outside the entity kernel.
  const otherUserId = testUserId("synthetic-household-visiting-member");
  await getDb(db).insert(schema.user).values({
    id: otherUserId,
    name: "Cedar Visiting Member",
    email: "visitor@household.example.test",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const otherMember = await insertWithShortcode(db, "ledgerParty", {
    name: "Cedar Visiting Member",
    kind: "member",
    userId: otherUserId,
  });
  const otherMemberCode = parseShortcodeFor(
    "ledgerParty",
    otherMember.shortcode,
  );
  const account = await create("financialAccount", {
    name: "Cedar Checking",
    identity: {
      kind: "bank_account",
      institution: "Example Bank",
      accountType: "checking",
    },
    ledgerPartyId: memberCode,
  });
  const cash = await create("financialAccount", {
    name: "Cedar Cash",
    ledgerPartyId: otherMemberCode,
  });
  await create("ledgerTransfer", {
    fromPartyId: guest.id,
    toPartyId: memberCode,
    amount: 18,
    date: day(-1),
    notes: "Contribution to the invented shared dinner.",
  });
  const locations = [];
  for (const name of [
    "Cedar Kitchen",
    "Cedar Pantry",
    "Cedar Workshop",
    "Cedar Raised Beds",
    "Cedar Wardrobe",
    "Cedar Hall Closet",
  ])
    locations.push(
      await create("location", {
        name,
        parentId: BASE_HOME_SHORTCODE,
        notes:
          "Synthetic household location.\nStored here for connected exploration.",
      }),
    );
  const pantry = locations[1]!;
  const garden = locations[3]!;
  const wardrobe = locations[4]!;
  await create("location", {
    name: "Cedar Pantry Upper Shelf",
    parentId: pantry.id,
  });
  await create("location", {
    name: "Cedar Wardrobe Shoe Rack",
    parentId: wardrobe.id,
  });

  const spending = [];
  for (const [name, emoji] of [
    ["Cedar Groceries", "🥕"],
    ["Cedar Garden", "🌱"],
    ["Cedar Maintenance", "🔧"],
    ["Cedar Clothing", null],
  ] as const)
    spending.push(await create("spendingCategory", { name, emoji }));
  const seedCategory = await create("productCategory", {
    name: "Cedar Seeds and Starts",
    emoji: "🌱",
    parentId: taxonomyShortcode("supplies"),
  });
  const projects = [];
  for (const [index, name] of [
    "Cedar Pantry Restock",
    "Cedar Autumn Garden",
    "Cedar Workshop Maintenance",
    "Cedar Wardrobe Refresh",
    "Cedar Seasonal Inspections",
    "Cedar Guest Weekend",
    "Cedar Finished Shelf Repair",
    "Cedar Future Kitchen Refresh",
  ].entries())
    projects.push(
      await create("project", {
        name,
        emoji: index % 2 ? null : "🧰",
        status: (["planning", "not_started", "in_progress", "done"] as const)[
          index % 4
        ],
        locations: [locations[index % locations.length]!.id],
        startDate: day(-60),
        endDate: day(30),
        notes:
          "Invented project with connected supplies, purchases, and work.\nSecond line exercises multiline facts.",
      }),
    );

  const vendors = [];
  const vendorAccounts = [];
  for (const [index, name] of [
    "Cedar Market",
    "Sprout Example Nursery",
    "Bench Example Tools",
    "Thread Example Outfitters",
  ].entries()) {
    const vendor = await create("vendor", {
      name,
      website: "https://example.com",
      defaultSpendingCategoryId: spending[index]!.id,
    });
    vendors.push(vendor);
    vendorAccounts.push(
      await create("vendorAccount", {
        label: `${name} household account`,
        vendorId: vendor.id,
        ledgerPartyId: memberCode,
      }),
    );
  }
  await create("vendorAccount", {
    label: "Cedar Market retired account",
    vendorId: vendors[0]!.id,
    ledgerPartyId: otherMemberCode,
    status: "disabled",
  });

  const ingredients: CreatedEntity[] = [];
  const foodProducts = [];
  for (const [index, name] of [
    "Rolled oats",
    "Carrots",
    "Red lentils",
    "Brown rice",
    "Lettuce",
    "Basil",
    "Chickpeas",
    "Tomatoes",
  ].entries()) {
    const ingredient = await create("ingredient", {
      name: `Cedar ${name}`,
      usuallyOnHand: index % 2 === 0,
    });
    ingredients.push(ingredient);
    const product = await create("product", {
      name: `Cedar ${name} package`,
      manufacturer: "Cedar Example Foods",
      ingredientId: ingredient.id,
      categoryId: taxonomyShortcode("food"),
      price: 3 + index,
      stockTracked: true,
      labelNutrition: {
        servingGrams: 100,
        nutrients: { kcal: 120 + index * 10, protein: 4, carbs: 20, fat: 2 },
        source: "Invented package label",
      },
    });
    foodProducts.push(product);
    await create("inventory", {
      productId: product.id,
      locationId: pantry.id,
      amount: { value: 500 + index * 100, unit: "g" },
    });
  }
  const tool = await create("product", {
    name: "Cedar Cordless Drill",
    manufacturer: "Bench Example Tools",
    model: "EX-12",
    categoryId: taxonomyShortcode("tools"),
    price: 85,
    notes: "Invented tool for the maintenance story.",
  });
  const phone = await create("product", {
    name: "Cedar Test Phone",
    manufacturer: "Example Devices",
    categoryId: taxonomyShortcode("electronics"),
    price: 250,
  });
  await create("device", {
    installationId: "synthetic-household-ios",
    name: "Cedar Exploration Phone",
    platform: "ios",
    productId: phone.id,
    ledgerPartyId: memberCode,
    automaticWork: false,
    remotePaused: true,
  });
  await create("device", {
    installationId: "synthetic-household-macos",
    name: "Cedar Exploration Mac",
    platform: "macos",
    ledgerPartyId: memberCode,
    automaticWork: false,
    remotePaused: true,
  });
  await create("inventory", {
    productId: tool.id,
    locationId: locations[2]!.id,
    amount: { value: 1, unit: "each" },
  });
  const clothing = [];
  for (const name of [
    "Cedar Cotton Field Shirt",
    "Cedar Garden Boots",
    "Cedar Wool Layer With a Particularly Long Descriptive Name for Narrow Detail Screens",
  ])
    clothing.push(
      await create("product", {
        name,
        manufacturer: "Thread Example Outfitters",
        categoryId: taxonomyShortcode("apparel"),
        notes:
          "Invented wardrobe piece.\nCare instructions: air dry and store on the upper shelf.",
      }),
    );
  for (const product of clothing)
    await create("inventory", {
      productId: product.id,
      locationId: wardrobe.id,
      amount: { value: 1, unit: "each" },
      ownershipMode: "explicit",
      ownerLedgerPartyId: memberCode,
    });

  const tasks = [];
  for (let index = 0; index < 32; index += 1)
    tasks.push(
      await create("task", {
        name:
          index === 0
            ? "Cedar Inspect Drill Battery"
            : `Cedar ${faker.word.verb()} household work ${index + 1}`,
        status: (["not_started", "later", "in_progress", "done"] as const)[
          index % 4
        ],
        projectId: projects[index % projects.length]!.id,
        subjectProductId:
          index % 2 ? foodProducts[index % foodProducts.length]!.id : tool.id,
        dueDate: day(index - 8),
        trade: "other",
      }),
    );
  await create("task", {
    name: "Cedar Inspect Drill Charger",
    parentTaskId: tasks[0]!.id,
    status: "not_started",
  });

  const seedProducts = [];
  for (const [index, name] of ["Lettuce", "Basil", "Carrots"].entries()) {
    const plant = await create("plant", {
      name: `Cedar ${name} cultivar`,
      gardenGuideKey: (["lettuce", "basil", "carrot"] as const)[index],
      ingredientId: ingredients[([4, 5, 1] as const)[index]!]!.id,
      notes: "Invented variety for the connected garden story.",
    });
    const seeds = await create("product", {
      name: `Cedar ${name} seed packet`,
      manufacturer: "Sprout Example Nursery",
      growsPlantId: plant.id,
      categoryId: seedCategory.id,
      price: 4,
    });
    seedProducts.push(seeds);
    await create("inventory", {
      productId: seeds.id,
      locationId: garden.id,
      amount: { value: 1, unit: "each" },
    });
    for (const [cycle, status] of (
      ["planned", "growing", "finished"] as const
    ).entries()) {
      const sowingDate = day(
        status === "planned" ? 3 : status === "growing" ? -14 : -55,
      );
      const gardenTask = await create("task", {
        name: `Cedar Sow ${name} ${status}`,
        projectId: projects[1]!.id,
        subjectProductId: seeds.id,
        dueDate: sowingDate,
        status: status === "planned" ? "not_started" : "done",
        trade: "other",
      });
      const planting = await create("planting", {
        plantId: plant.id,
        sourceProductId: seeds.id,
        locationId: garden.id,
        taskId: gardenTask.id,
        status,
        outcome:
          status === "finished" ? (index === 2 ? "failed" : "succeeded") : null,
        quantity: "Six starts",
        plannedWindow: "Autumn",
        sowedOn: status === "planned" ? null : sowingDate,
        finishedOn: status === "finished" ? day(-7) : null,
      });
      await create("gardenEntry", {
        locationId: garden.id,
        plantingIds: [planting.id],
        kind: status === "finished" && index !== 2 ? "harvest" : "note",
        harvestAmount: status === "finished" && index !== 2 ? "250 g" : null,
        observedOn: status === "finished" ? day(-7) : day(-cycle * 3),
        notes:
          status === "finished" && index === 2
            ? "Crop failed after an invented dry spell."
            : status === "planned"
              ? "Bed prepared; awaiting sowing."
              : "Leaves healthy.\nWatered the bed and checked soil moisture.",
      });
    }
  }

  // Cookbook creation has no generic create command; use the import repository
  // and its provenance writer rather than inventing a second stored shape.
  const bundle = syntheticBundle("Cedar Weeknight Cookbook");
  const book = await upsertCookbook(
    db,
    upsertCookbookInput.parse({
      name: "Cedar Weeknight Cookbook",
      rawJson: bundle.cookbook,
      report: bundle.report,
      sourceLabel: "synthetic.cookbook",
      bundleManifest: bundle.manifest,
    }),
    context.actorContext,
  );
  const recipes: CreatedEntity[] = [
    await createRecipe(
      db,
      buildEntity("recipe", {
        name: "Cedar Weeknight Cookbook carrots",
        sections: [
          {
            ingredients: [
              {
                type: "ingredient",
                ingredientId: ingredients[1]!.id,
                recipeId: null,
                amounts: [{ value: 1, unit: "each" }],
              },
            ],
            instructions: [{ instruction: "Slice the carrot." }],
          },
        ],
      }),
      context.actorContext,
      { sourceType: "Book", sourceData: null, cookbookId: book.entityId },
    ),
  ];
  for (let index = 0; index < 11; index += 1) {
    recipes.push(
      await create("recipe", {
        name:
          [
            "Cedar Breakfast Oats",
            "Cedar Carrot and Lentil Pot",
            "Cedar Garden Rice Bowl",
          ][index] ?? `Cedar Weeknight Bowl ${index + 1}`,
        servings: 2,
        notes: "Invented recipe with pantry ingredients.",
        sections: [
          {
            ingredients: [0, 1].map((offset) => ({
              type: "ingredient" as const,
              ingredientId:
                ingredients[(index + offset) % ingredients.length]!.id,
              recipeId: null,
              amounts: [{ value: 100, unit: "g" }],
            })),
            instructions: [
              { instruction: "Combine the ingredients and cook until tender." },
            ],
          },
        ],
      }),
    );
  }
  for (let index = 0; index < 16; index += 1) {
    const meal = await create("meal", {
      name: `Cedar ${index % 2 ? "Garden Supper" : "Pantry Lunch"} ${index + 1}`,
      date: day(index - 8),
      recipes: [
        {
          recipeId: recipes[index % recipes.length]!.id,
          scale: index % 3 === 0 ? 2 : 1,
        },
      ],
    });
    if (index < 8)
      await saveMealFood(
        db,
        saveMealFoodInput.parse({
          mealId: meal.id,
          ledgerPartyId: index % 2 ? guest.id : memberCode,
          sourceKind: "product",
          productId: foodProducts[index % foodProducts.length]!.id,
          amount: { value: 100, unit: "g" },
        }),
        context.actorContext,
      );
  }

  const products = [...foodProducts, tool, phone, ...clothing, ...seedProducts];
  for (let index = 0; index < 32; index += 1) {
    const category = (["household", "tools", "apparel", "supplies"] as const)[
      index % 4
    ]!;
    const product = await create("product", {
      name: `Cedar ${faker.commerce.productName()} ${index + 1}`,
      manufacturer: faker.company.name(),
      categoryId: taxonomyShortcode(category),
      price: faker.number.int({ min: 5, max: 120 }),
      model: null,
    });
    products.push(product);
    await create("inventory", {
      productId: product.id,
      locationId: locations[index % locations.length]!.id,
      amount: { value: faker.number.int({ min: 1, max: 8 }), unit: "each" },
    });
  }
  const purchases = [];
  for (let index = 0; index < 20; index += 1) {
    const vendorIndex = index % vendors.length;
    const project = projects[vendorIndex]!;
    const purchaseDate = day(index - 20);
    const purchase = await create("purchase", {
      vendorId: vendors[vendorIndex]!.id,
      vendorAccountId: vendorAccounts[vendorIndex]!.id,
      defaultProjectId: project.id,
      spendingCategoryId: spending[vendorIndex]!.id,
      orderId: `CEDAR-DEMO-${String(index + 1).padStart(3, "0")}`,
      date: purchaseDate,
      statedTotal: 24,
      defaultTrade: "other",
    });
    purchases.push(purchase);
    for (let line = 0; line < 2; line += 1) {
      const domainProducts = [foodProducts, seedProducts, [tool], clothing][
        vendorIndex
      ]!;
      const product =
        domainProducts[
          (Math.floor(index / vendors.length) * 2 + line) %
            domainProducts.length
        ]!;
      await create("expense", {
        name: `Cedar supply line ${index + 1}.${line + 1}`,
        purchaseId: purchase.id,
        projectId: project.id,
        productId: product.id,
        productQuantity: 1,
        cost: 12,
        date: purchaseDate,
        trade: "other",
        beneficiaries: [
          { partyId: memberCode, weight: 1 },
          { partyId: guest.id, weight: 1 },
        ],
        funders: [
          { partyId: index % 2 ? otherMemberCode : memberCode, weight: 1 },
        ],
      });
    }
    await create("financialTransaction", {
      accountId: index % 2 ? cash.id : account.id,
      purchaseId: purchase.id,
      kind: "purchase",
      status: index % 3 ? "posted" : "expected",
      postedDate: index % 3 ? shiftPlainDate(purchaseDate, 1) : null,
      transactionDate: purchaseDate,
      amount: 24,
      merchant: [
        "Cedar Market",
        "Sprout Example Nursery",
        "Bench Example Tools",
        "Thread Example Outfitters",
      ][vendorIndex],
    });
  }
  await create("expense", {
    name: "Cedar Planned Workshop Supplies",
    cost: 35,
    future: true,
    date: day(20),
    projectId: projects[2]!.id,
    trade: "other",
  });
  for (let index = 0; index < 10; index += 1)
    await create("wish", {
      name: `Cedar Future Supply ${index + 1}`,
      candidateProductIds: [products[index]!.id, products[index + 1]!.id],
      notes: "Compare two invented candidates before buying.",
    });

  const memberId = (
    await pool.query<{ id: string }>(
      'SELECT id FROM "LedgerParty" WHERE shortcode = $1',
      [memberCode],
    )
  ).rows[0]!.id;
  const vendorId = (
    await pool.query<{ id: string }>(
      'SELECT id FROM "Vendor" WHERE shortcode = $1',
      [vendors[0]!.id],
    )
  ).rows[0]!.id;
  const bodyText = `Cedar Market. Order CEDAR-DEMO-001. Ordered ${day(-20)}. Total 24 USD. Invented receipt for development.`;
  const checksum = createHash("sha256").update(bodyText).digest("hex");
  const [mail] = await getDb(db)
    .insert(schema.orderMail)
    .values({
      ledgerPartyId: parseEntityId("ledgerParty", memberId),
      vendorId: parseEntityId("vendor", vendorId),
      rawChecksum: checksum,
      content: { bodyText, bodyHtml: null, snippet: null },
    })
    .returning();
  if (!mail) throw new Error("Household email evidence was not saved");
  await getDb(db)
    .insert(schema.orderMailEvent)
    .values({
      orderMailId: mail.id,
      event: "placed",
      orderId: "CEDAR-DEMO-001",
      amount: 24,
      currency: "USD",
      sourceKey: `classified:${checksum}:0`,
    });
  await insertWithShortcode(db, "email", {
    ledgerPartyId: parseEntityId("ledgerParty", memberId),
    orderMailId: mail.id,
    mailboxId: "synthetic-household-mailbox",
    messageId: "synthetic-household-order-001",
    sender: "Cedar Market <orders@example.test>",
    subject: "Cedar Market synthetic receipt",
    receivedAt: householdDateTime(day(-20), 15 * 60),
    checksum,
    classification: "uncertain",
    classificationVersion: "synthetic-household/v1",
    status: "blocked",
  });

  await seedHouseholdPhotos(db, context, userId, storage, clothing);
}

async function seedHouseholdPhotos(
  db: Database,
  context: KernelContext,
  userId: string,
  storage: HouseholdStorage,
  clothing: readonly CreatedEntity[],
) {
  const run = await startPhotoInventoryRun(db, {
    actorUserId: testUserId(userId),
    notes:
      "Cedar Wardrobe Photo Pass — synthetic pending work; no provider dispatch.",
  });
  const failedRun = await startPhotoInventoryRun(db, {
    actorUserId: testUserId(userId),
    notes: "Cedar Failed Photo Pass — invented failure state.",
  });
  await markRunFailed(db, {
    runId: failedRun.id,
    failureCode: "agent_failed",
    detail: "Synthetic fixture failure: photo processing did not complete.",
  });
  for (const [index, label] of (
    ["shirt", "boots", "label"] as const
  ).entries()) {
    const bytes = await readFile(
      new URL(
        `../../tests/e2e/fixtures/synthetic-wardrobe-${label}.png`,
        import.meta.url,
      ),
    );
    const key = `${storage.keyPrefix}/household/${label}.png`;
    const upload = await fetch(
      `${storage.storageOrigin}/${encodeURIComponent(storage.bucket)}/${key}`,
      { method: "PUT", headers: { "Content-Type": "image/png" }, body: bytes },
    );
    if (!upload.ok)
      throw new Error(
        `Household image storage failed: ${upload.status} ${await upload.text()}`,
      );
    const image = await createUploadedImageRecord(db, {
      key,
      filename: `synthetic-household-${label}.png`,
      contentType: "image/png",
      size: bytes.length,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      detectedContentType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      renderStatus: "verified",
      storageStatus: "available",
      verifiedAt: new Date(),
    });
    await attachExistingImageToEntity(
      db,
      {
        imageId: parseShortcodeFor("image", image.shortcode),
        targetId: clothing[index === 2 ? 0 : index]!.id,
        purpose: index === 2 ? "label" : "item",
      },
      context.actorContext,
    );
    await getDb(db)
      .insert(schema.photoRunImage)
      .values({
        runId: parseEntityId("run", run.id),
        imageId: parseEntityId("image", image.id),
        workKey: image.shortcode,
        position: index,
        state: "pending",
        targetFingerprint: `synthetic-household-${label}`,
      });
    // One finished description job, so the Image job list has a household row.
    if (index === 0)
      await insertWithShortcode(db, "imageJob", {
        imageId: parseEntityId("image", image.id),
        runId: parseEntityId("run", run.id),
        kind: "describe_image",
        state: "ready",
        sourceContentHash: createHash("sha256").update(bytes).digest("hex"),
        processorRevision: 1,
        attempts: 1,
        completedAt: new Date(),
      });
  }
  // This retained attachment deliberately has no bytes: it exercises the
  // unavailable-photo placeholder alongside Products with no attachment at all.
  const missing = await createUploadedImageRecord(db, {
    key: `${storage.keyPrefix}/household/missing.png`,
    filename: "synthetic-household-missing.png",
    contentType: "image/png",
    size: 100,
    storageStatus: "missing",
    renderStatus: "unverified",
  });
  await attachExistingImageToEntity(
    db,
    {
      imageId: parseShortcodeFor("image", missing.shortcode),
      targetId: clothing[2]!.id,
    },
    context.actorContext,
  );
}

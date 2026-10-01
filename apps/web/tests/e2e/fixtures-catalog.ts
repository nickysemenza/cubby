import type { EntityOverrides } from "../../tooling/factories/build";
import { taxonomyShortcode } from "../../tooling/product-category-fixtures";
import { type ProductCreateInput } from "@cubby/schemas/product";
import { type TaskStatus } from "@cubby/schemas/project";
import type { Page } from "@playwright/test";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  getFixtureDb,
  seedConcurrently,
  createEntityFixture,
} from "./fixtures-core";

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
  createEntityFixture(page, "productCategory", {
    name: opts.name,
    aliases: opts.aliases ?? [],
    description: opts.description ?? null,
    parentId: opts.parentId ?? null,
    sortOrder: 0,
    feature: null,
  });

export const seedTaskPrerequisite = (
  page: Page,
  opts: {
    name: string;
    dueDate?: string;
    status?: TaskStatus;
    projectId?: string;
  },
) =>
  createEntityFixture(page, "task", {
    name: opts.name,
    trade: "other",
    dueDate: opts.dueDate,
    status: opts.status,
    projectId: opts.projectId,
  });

export const seedLocationPrerequisite = (
  page: Page,
  name: string,
  opts: { parentId?: string } = {},
) =>
  createEntityFixture(page, "location", {
    name,
    type: "room",
    parentId: opts.parentId ?? null,
  });

export const seedPlantingPrerequisite = (
  page: Page,
  opts: {
    plantId: string;
    locationId?: string;
    status?: EntityOverrides<"planting">["status"];
    taskId?: string;
  },
) =>
  createEntityFixture(page, "planting", {
    plantId: opts.plantId,
    locationId: opts.locationId ?? null,
    status: opts.status,
    taskId: opts.taskId,
  });

export const seedProductPrerequisite = (
  page: Page,
  opts: {
    name: string;
    manufacturer?: string;
    categoryId?: string;
    growsPlantId?: string;
    externalIds?: ProductCreateInput["externalIds"];
    tags?: string[];
  },
) =>
  createEntityFixture(page, "product", {
    name: opts.name,
    manufacturer: opts.manufacturer ?? "E2E fixture",
    categoryId: opts.categoryId,
    growsPlantId: opts.growsPlantId,
    externalIds: opts.externalIds,
    tags: opts.tags ?? [],
  });

export const seedProjectPrerequisite = (page: Page, name: string) =>
  createEntityFixture(page, "project", { name });

export const seedUnlinkedExpensePrerequisite = (page: Page, name: string) =>
  createEntityFixture(page, "expense", {
    name,
    cost: 87,
    date: "2026-01-05",
    costType: "materials",
    trade: "other",
    lineKind: "principal",
    lineBasis: "item_line",
  });

export async function seedPlantPurchasePrerequisite(
  page: Page,
  opts: { plantId: string; vendorId: string; name: string },
) {
  const product = await seedProductPrerequisite(page, {
    name: `${opts.name} product`,
    growsPlantId: opts.plantId,
  });
  const purchase = await createEntityFixture(page, "purchase", {
    vendorId: opts.vendorId,
    orderId: `${opts.name} order`,
    date: "2026-09-09",
  });
  await createEntityFixture(page, "expense", {
    name: `${opts.name} expense`,
    cost: 7,
    date: "2026-09-09",
    costType: "materials",
    trade: "other",
    productId: product.id,
    productQuantity: 1,
    purchaseId: purchase.id,
  });
  return { product, purchase };
}

export const seedInventoryPrerequisites = (
  page: Page,
  opts: {
    locationName: string;
    products: Array<{ name: string; quantity: number; unit: string }>;
  },
) =>
  (async () => {
    const location = await seedLocationPrerequisite(page, opts.locationName);
    const products = await seedConcurrently(opts.products, async (product) => {
      const created = await seedProductPrerequisite(page, {
        name: product.name,
      });
      await createEntityFixture(page, "inventory", {
        productId: created.id,
        locationId: location.id,
        amount: { value: product.quantity, unit: product.unit },
      });
      return created;
    });
    return { products, location };
  })();

export async function seedToolFlowPrerequisite(
  page: Page,
  groups: ReadonlyArray<{
    locationName: string;
    productNames: readonly string[];
  }>,
) {
  const located = await seedConcurrently(groups, async (group) => ({
    ...group,
    location: await seedLocationPrerequisite(page, group.locationName),
  }));
  const placements = located.flatMap((group) =>
    group.productNames.map((name) => ({ name, group })),
  );
  const products = await seedConcurrently(placements, async (placement) => {
    const product = await createEntityFixture(page, "product", {
      name: placement.name,
      manufacturer: "Flow fixture maker",
      categoryId: taxonomyShortcode("tools"),
    });
    await createEntityFixture(page, "inventory", {
      productId: product.id,
      locationId: placement.group.location.id,
      amount: { value: 1, unit: "each" },
    });
    return product;
  });
  return located.map((group) => ({
    ...group,
    products: products.filter((_, index) => placements[index]?.group === group),
  }));
}

export const seedIngredientPrerequisite = (page: Page, name: string) =>
  createEntityFixture(page, "ingredient", { name });

export const seedPlantPrerequisite = (page: Page, name: string) =>
  createEntityFixture(page, "plant", { name });

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
  const destination = await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: target.id,
    amount: { value: 1, unit: "each" },
  });
  const source = await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: unknown.id,
    amount: { value: 1, unit: "each" },
  });
  return { source, destination, target };
}

/** One catalog garment, two independently owned quantities in different places. */
export async function seedWardrobePrerequisites(page: Page, name: string) {
  const owner = await createEntityFixture(page, "ledgerParty", {
    name: `${name} owner`,
    kind: "member",
  });
  const other = await createEntityFixture(page, "ledgerParty", {
    name: `${name} other`,
    kind: "guest",
  });
  const location = await seedLocationPrerequisite(page, `${name} drawer`);
  const otherLocation = await seedLocationPrerequisite(
    page,
    `${name} other drawer`,
  );
  const product = await createEntityFixture(page, "product", {
    name: `${name} shirt`,
    manufacturer: "Fixture",
    categoryId: taxonomyShortcode("apparel"),
  });
  const entry = await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: location.id,
    amount: { value: 3, unit: "each" },
    ownershipMode: "person",
    ownerLedgerPartyId: owner.id,
  });
  await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: otherLocation.id,
    amount: { value: 7, unit: "each" },
    ownershipMode: "person",
    ownerLedgerPartyId: other.id,
  });
  return { owner, other, location, otherLocation, product, entry };
}

export const seedVendorDisplayPrerequisite = (page: Page, name: string) =>
  createEntityFixture(page, "vendor", {
    name,
    website: "https://example.com",
    orderUrlTemplate: "https://example.com/orders/{orderId}",
    notes: `${name} notes`,
  });

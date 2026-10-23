import { publishEntityConnection } from "~/server/domains/connection/repo/entity-connections";
import type { EntityOverrides } from "#web/tooling/factories/build.ts";
import { taxonomyShortcode } from "#web/tooling/product-category-fixtures.ts";
import { type TaskStatus } from "@cubby/schemas/project";
import type { Page } from "@playwright/test";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "~/server/db/schema";
import { getDb } from "~/server/db/helpers";
import { getFixtureDb, createFixtureGraph, createEntityFixture } from "./core";

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
    due?: EntityOverrides<"task">["due"];
    status?: TaskStatus;
    projectId?: string;
  },
) =>
  createEntityFixture(page, "task", {
    name: opts.name,
    trade: "other",
    due: opts.due,
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
  opts: EntityOverrides<"product"> & { name: string; brandName?: string },
) =>
  createFixtureGraph(page, async (create) => {
    const { brandName, brandId, ...product } = opts;
    const reference =
      brandId !== undefined
        ? brandId
        : (await create("vendor", { name: brandName ?? "E2E fixture" })).id;
    return create("product", { ...product, brandId: reference });
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

export const seedInventoryPrerequisites = (
  page: Page,
  opts: {
    locationName: string;
    products: Array<{ name: string; quantity: number; unit: string }>;
  },
) =>
  createFixtureGraph(page, async (create) => {
    const location = await create("location", {
      name: opts.locationName,
      type: "room",
      parentId: null,
    });
    const brand = await create("vendor", { name: "E2E fixture" });
    const products = [];
    for (const product of opts.products) {
      const created = await create("product", {
        name: product.name,
        brandId: brand.id,
        tags: [],
      });
      await create("inventory", {
        productId: created.id,
        locationId: location.id,
        amount: { value: product.quantity, unit: product.unit },
      });
      products.push(created);
    }
    return { products, location };
  });

export async function seedToolFlowPrerequisite(
  page: Page,
  groups: ReadonlyArray<{
    locationName: string;
    productNames: readonly string[];
  }>,
) {
  return createFixtureGraph(page, async (create) => {
    const brand = await create("vendor", { name: "Flow fixture maker" });
    const located = [];
    for (const group of groups) {
      const location = await create("location", {
        name: group.locationName,
        type: "room",
        parentId: null,
      });
      const products = [];
      for (const name of group.productNames) {
        const product = await create("product", {
          name,
          brandId: brand.id,
          categoryId: taxonomyShortcode("tools"),
        });
        await create("inventory", {
          productId: product.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        });
        products.push(product);
      }
      located.push({ ...group, location, products });
    }
    return located;
  });
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
  // Passive record reads expose only proposals already published by a Sweep.
  await publishEntityConnection(getFixtureDb(), {
    relation: "inventory-location",
    source: { entityKind: "inventory", entityId: source.id },
    target: { entityKind: "location", entityId: target.id },
    label: "Review inventory placement",
    evidence: {
      reasons: ["Synthetic exact Product stock at one known destination"],
      contradictions: [],
      unknowns: ["Confirm the physical location"],
    },
  });
  return { source, destination, target };
}

/** One catalog garment, two independently owned quantities in different places. */
export async function seedWardrobePrerequisites(page: Page, name: string) {
  return createFixtureGraph(page, async (create) => {
    const owner = await create("ledgerParty", {
      name: `${name} owner`,
      kind: "member",
    });
    const other = await create("ledgerParty", {
      name: `${name} other`,
      kind: "guest",
    });
    const location = await create("location", {
      name: `${name} drawer`,
      type: "room",
      parentId: null,
    });
    const otherLocation = await create("location", {
      name: `${name} other drawer`,
      type: "room",
      parentId: null,
    });
    const brand = await create("vendor", { name: "Fixture" });
    const product = await create("product", {
      name: `${name} shirt`,
      brandId: brand.id,
      categoryId: taxonomyShortcode("apparel"),
    });
    const entry = await create("inventory", {
      productId: product.id,
      locationId: location.id,
      amount: { value: 3, unit: "each" },
      ownershipMode: "explicit",
      ownerLedgerPartyId: owner.id,
    });
    await create("inventory", {
      productId: product.id,
      locationId: otherLocation.id,
      amount: { value: 7, unit: "each" },
      ownershipMode: "explicit",
      ownerLedgerPartyId: other.id,
    });
    return { owner, other, location, otherLocation, product, entry };
  });
}

export const seedVendorDisplayPrerequisite = (page: Page, name: string) =>
  createEntityFixture(page, "vendor", {
    name,
    website: "https://example.com",
    orderUrlTemplate: "https://example.com/orders/{orderId}",
    notes: `${name} notes`,
  });

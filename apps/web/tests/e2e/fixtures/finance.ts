import { resolveProductBrandName } from "~/server/domains/vendor/repo/product-brand";
import { publishEntityConnection } from "~/server/domains/connection/repo/entity-connections";
import type { Page } from "@playwright/test";
import { count, eq } from "drizzle-orm";
import * as schema from "~/server/db/schema";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { getDb } from "~/server/db/helpers";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { seedVendorDisplayPrerequisite } from "./catalog";
import {
  getFixtureDb,
  createEntityFixture,
  createFixtureGraph,
  ensureMemberParty,
} from "./core";

/** Two Purchases sharing one unallocated synthetic statement charge. */
export async function seedSplitSettlementPrerequisite(
  page: Page,
  name: string,
) {
  const db = getFixtureDb();
  const member = await ensureMemberParty(page, name);
  const vendor = await insertWithShortcode(db, "vendor", { name });
  const first = await insertWithShortcode(db, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-SPLIT-1",
    date: "2026-09-10",
    statedTotal: 42.5,
  });
  const second = await insertWithShortcode(db, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-SPLIT-2",
    date: "2026-09-10",
    statedTotal: 48.5,
  });
  const card = await insertWithShortcode(db, "financialAccount", {
    name: `${name} card`,
    identity: { kind: "credit_card", network: "visa" },
    ledgerPartyId: member.id,
  });
  const transaction = await insertWithShortcode(db, "financialTransaction", {
    accountId: card.id,
    kind: "purchase",
    status: "posted",
    amount: 91,
    merchant: name,
    transactionDate: "2026-09-12",
    postedDate: "2026-09-12",
  });
  return { first, second, transaction };
}

export async function seedRecordListDisplayPrerequisite(
  page: Page,
  name: string,
) {
  return createFixtureGraph(page, async (create, db) => {
    const vendor = await create("vendor", {
      name: `${name} vendor`,
      website: "https://example.com",
      orderUrlTemplate: "https://example.com/orders/{orderId}",
      notes: `${name} vendor notes`,
    });
    const brandId = await resolveProductBrandName(db, "E2E fixture");
    const product = await create("product", {
      brandId,
      tags: [],
      name: `${name} product`,
    });
    const location = await create("location", {
      name: `${name} room`,
      type: "room",
      parentId: null,
    });
    const child = await create("location", {
      name: `${name} shelf`,
      type: "room",
      parentId: location.id,
    });
    await create("inventory", {
      productId: product.id,
      locationId: location.id,
      amount: { value: 2, unit: "each" },
    });
    const orderId = `${name} order`;
    const purchase = await create("purchase", {
      vendorId: vendor.id,
      orderId,
      date: "2026-09-09",
      statedTotal: 12.34,
      notes: `${name} purchase notes`,
    });
    const expense = await create("expense", {
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
  });
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
  const { current, target, product, expense } = await createFixtureGraph(
    page,
    async (create, db) => {
      const current = await create("project", {
        name: `${name} current`,
        dates: { start: `${year}-05-01`, end: `${year}-05-31` },
      });
      const target = await create("project", {
        name: `${name} suggested`,
        dates: { start: `${year}-05-01`, end: `${year}-05-31` },
      });
      const brandId = await resolveProductBrandName(db, "E2E fixture");
      const product = await create("product", {
        brandId,
        name: `${name} switch`,
      });
      await create("expense", {
        name: `${name} supporting expense`,
        projectId: target.id,
        productId: product.id,
        date: `${year}-05-02`,
        cost: 10,
        trade: "electrical",
        costType: "materials",
      });
      const expense = await create("expense", {
        name: `${name} reviewed expense`,
        projectId: current.id,
        productId: product.id,
        date: `${year}-05-10`,
        cost: 20,
        trade: "electrical",
        costType: "materials",
      });
      return { current, target, product, expense };
    },
  );
  // Passive record reads expose only proposals already published by a Sweep.
  await publishEntityConnection(getFixtureDb(), {
    relation: "expense-project",
    source: { entityKind: "expense", entityId: expense.id },
    target: { entityKind: "project", entityId: target.id },
    label: "Review Project assignment",
    evidence: {
      reasons: ["Synthetic matching trade and date window"],
      contradictions: [],
      unknowns: ["Confirm the intended Project"],
    },
  });
  return { current, target, product, expense };
}

export async function seedInheritancePrerequisite(page: Page, name: string) {
  return createFixtureGraph(page, async (create) => {
    const project = await create("project", {
      name: `${name} project`,
      defaultTrade: "building",
    });
    const vendor = await create("vendor", {
      name: `${name} vendor`,
      website: "https://example.com",
      orderUrlTemplate: "https://example.com/orders/{orderId}",
      notes: `${name} vendor notes`,
    });
    const purchase = await create("purchase", {
      vendorId: vendor.id,
      date: "2026-09-20",
      defaultProjectId: project.id,
    });
    const expense = await create("expense", {
      name: `${name} item`,
      date: "2026-09-20",
      purchaseId: purchase.id,
      projectId: project.id,
      lineKind: "principal",
      lineBasis: "item_line",
      cost: 10,
      costType: "materials",
    });
    return { project, expense };
  });
}

export async function seedPurchaseHeicAttachment(page: Page, name: string) {
  const vendor = await seedVendorDisplayPrerequisite(page, `${name} vendor`);
  const purchase = await createEntityFixture(page, "purchase", {
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
  await db.insert(schema.entityAttachment).values({
    entityId: owner.id,
    entityKind: "purchase",
    role: "attachment",
    imageId: attached.id,
    documentKind: "other",
  });
  return { purchase, filename: attached.filename };
}

/**
 * A project whose contribution has two party kinds (a member and a guest), a
 * credit, and one expense with no recorded funder (an attribution gap).
 */
export async function seedProjectContributionPrerequisite(
  page: Page,
  name: string,
) {
  const member = await ensureMemberParty(page, name);
  return createFixtureGraph(page, async (create) => {
    const guest = await create("ledgerParty", {
      name: `${name} guest`,
      kind: "guest",
    });
    const project = await create("project", { name });
    const expense = (label: string, cost: number, funded: boolean) =>
      create("expense", {
        name: `${name} ${label}`,
        projectId: project.id,
        date: "2026-09-01",
        cost,
        trade: "other",
        costType: "materials",
        beneficiaries: [
          { partyId: member.shortcode, weight: 3 },
          { partyId: guest.id, weight: 1 },
        ],
        funders: funded ? [{ partyId: member.shortcode, weight: 1 }] : [],
      });
    await expense("lumber", 100.49, true);
    await expense("returned lumber", -20.13, true);
    const unfunded = await expense("paint", 40.08, false);
    return { project, member, guestName: `${name} guest`, unfunded };
  });
}

import type { Page } from "@playwright/test";
import { count, eq } from "drizzle-orm";
import * as schema from "~/server/db/schema";
import { createUploadedImageRecord } from "~/server/repo/image";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  seedLocationPrerequisite,
  seedProductPrerequisite,
  seedVendorDisplayPrerequisite,
} from "./fixtures-catalog";
import {
  getFixtureDb,
  createEntityFixture,
  ensureMemberParty,
} from "./fixtures-core";

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
    identity: { kind: "credit_card", issuer: null, network: "visa" },
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
  const vendor = await seedVendorDisplayPrerequisite(page, `${name} vendor`);
  const product = await seedProductPrerequisite(page, {
    name: `${name} product`,
  });
  const location = await seedLocationPrerequisite(page, `${name} room`);
  const child = await seedLocationPrerequisite(page, `${name} shelf`, {
    parentId: location.id,
  });
  await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: location.id,
    amount: { value: 2, unit: "each" },
  });
  const orderId = `${name} order`;
  const purchase = await createEntityFixture(page, "purchase", {
    vendorId: vendor.id,
    orderId,
    date: "2026-09-09",
    statedTotal: 12.34,
    notes: `${name} purchase notes`,
  });
  const expense = await createEntityFixture(page, "expense", {
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

export async function seedRelationshipReviewPrerequisite(
  page: Page,
  name: string,
) {
  // Separate date windows keep earlier browser cases out of the top-three candidates.
  const [projectCount] = await getDb(getFixtureDb())
    .select({ value: count() })
    .from(schema.project);
  const year = 2100 + (projectCount?.value ?? 0);
  const current = await createEntityFixture(page, "project", {
    name: `${name} current`,
    startDate: `${year}-05-01`,
    endDate: `${year}-05-31`,
  });
  const target = await createEntityFixture(page, "project", {
    name: `${name} suggested`,
    startDate: `${year}-05-01`,
    endDate: `${year}-05-31`,
  });
  const product = await seedProductPrerequisite(page, {
    name: `${name} switch`,
  });
  await createEntityFixture(page, "expense", {
    name: `${name} supporting expense`,
    projectId: target.id,
    productId: product.id,
    date: `${year}-05-02`,
    cost: 10,
    trade: "electrical",
    costType: "materials",
  });
  const expense = await createEntityFixture(page, "expense", {
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

export async function seedInheritancePrerequisite(page: Page, name: string) {
  const project = await createEntityFixture(page, "project", {
    name: `${name} project`,
    defaultTrade: "building",
  });
  const vendor = await seedVendorDisplayPrerequisite(page, `${name} vendor`);
  const purchase = await createEntityFixture(page, "purchase", {
    vendorId: vendor.id,
    date: "2026-09-20",
    defaultProjectId: project.id,
  });
  const expense = await createEntityFixture(page, "expense", {
    name: `${name} item`,
    date: "2026-09-20",
    purchaseId: purchase.id,
    projectId: project.id,
    cost: 10,
    costType: "materials",
  });
  const charge = await createEntityFixture(page, "expense", {
    name: `${name} tax`,
    date: "2026-09-20",
    purchaseId: purchase.id,
    cost: 1,
    costType: "services",
    lineKind: "tax",
  });
  return { project, purchase, expense, charge };
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

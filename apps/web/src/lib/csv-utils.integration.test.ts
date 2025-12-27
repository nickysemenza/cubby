import fs from "node:fs";
import path from "node:path";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActorContext } from "~/schemas/context";
import type { OrganizationId } from "~/schemas/identifiers";
import type { Database } from "~/server/db";
import { importInventoryFromCSV } from "~/server/repo/inventory";
import {
  findLocationByName,
  findOrCreateLocationByName,
  locationList,
} from "~/server/repo/location";
import { productList } from "~/server/repo/product";
import { parseInventoryCSV, parseLocationsCSV } from "./csv-utils";

const readConfigCSV = (): ReturnType<typeof parseInventoryCSV> => {
  const filePath = path.join(__dirname, "../../config.csv");
  const csvContent = fs.readFileSync(filePath, "utf8");
  return parseInventoryCSV(csvContent);
};

const readLocationsCSV = (): ReturnType<typeof parseLocationsCSV> => {
  const filePath = path.join(__dirname, "../../locations.csv");
  const csvContent = fs.readFileSync(filePath, "utf8");
  return parseLocationsCSV(csvContent);
};

/**
 * Import locations from locations.csv before importing inventory
 */
const seedLocations = async (
  db: Database,
  organizationId: OrganizationId,
): Promise<void> => {
  const rows = readLocationsCSV();
  for (const row of rows) {
    // Find parent if specified
    let parentId = null;
    if (row.parent_name) {
      parentId = await findLocationByName(db, organizationId, row.parent_name);
    }
    await findOrCreateLocationByName(
      db,
      organizationId,
      row.location_name,
      parentId,
      row.location_type ?? (parentId ? "shelf" : "room"),
    );
  }
};

describe("config.csv import integration", () => {
  let db: Database;
  let organizationId: OrganizationId;
  let actor: ActorContext;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, organizationId, actor, teardown } = await buildTestDB());
    return teardown;
  });

  it("should parse config.csv without errors", () => {
    const rows = readConfigCSV();
    expect(rows.length).toBeGreaterThan(0);
  });

  it("should import all rows into database without errors", async () => {
    await seedLocations(db, organizationId);
    const rows = readConfigCSV();

    const result = await importInventoryFromCSV(db, organizationId, rows, {
      dryRun: false,
      actor: actor,
    });

    expect(result.errors).toBe(0);
    expect(result.created + result.productOnly).toBeGreaterThan(0);
  });

  it("should create expected products from config.csv", async () => {
    await seedLocations(db, organizationId);
    const rows = readConfigCSV();
    await importInventoryFromCSV(db, organizationId, rows, {
      dryRun: false,
      actor: actor,
    });

    const products = await productList(
      db,
      organizationId,
      undefined,
      undefined,
      undefined,
      undefined,
      { orderBy: "name", direction: "asc" },
      { pageIndex: 0, pageSize: 100 },
    );

    const productNames = products.data.map((p) => p.name.toLowerCase());
    expect(productNames.some((name) => name.includes("sugar"))).toBe(true);
    expect(productNames.some((name) => name.includes("flour"))).toBe(true);
  });

  it("should create locations with correct types from locations.csv", async () => {
    await seedLocations(db, organizationId);

    const locations = await locationList(
      db,
      organizationId,
      {},
      { orderBy: "name", direction: "asc" },
      { pageIndex: 0, pageSize: 100 },
    );

    const garage = locations.data.find((l) => l.name === "garage");
    if (garage) {
      expect(garage.type).toBe("room");
    }

    const toolbag = locations.data.find((l) => l.name === "toolbag");
    if (toolbag) {
      expect(toolbag.type).toBe("bag");
    }
  });

  it("should be idempotent - re-importing skips existing items", async () => {
    await seedLocations(db, organizationId);
    const rows = readConfigCSV();

    await importInventoryFromCSV(db, organizationId, rows, {
      dryRun: false,
      actor: actor,
    });
    const result2 = await importInventoryFromCSV(db, organizationId, rows, {
      dryRun: false,
      actor: actor,
    });

    expect(result2.skipped).toBeGreaterThan(0);
    expect(result2.errors).toBe(0);
  });
});

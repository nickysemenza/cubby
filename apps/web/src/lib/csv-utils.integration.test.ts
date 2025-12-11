import { beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { type Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import { type OrganizationId } from "~/schemas/identifiers";
import { parseInventoryCSV } from "./csv-utils";
import { importInventoryFromCSV } from "~/server/repo/inventory";
import { locationList } from "~/server/repo/location";
import { productList } from "~/server/repo/product";

const readConfigCSV = (): ReturnType<typeof parseInventoryCSV> => {
  const filePath = path.join(__dirname, "../../config.csv");
  const csvContent = fs.readFileSync(filePath, "utf8");
  return parseInventoryCSV(csvContent);
};

describe("config.csv import integration", () => {
  let db: Database;
  let organizationId: OrganizationId;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, organizationId, teardown } = await buildTestDB());
    return teardown;
  });

  it("should parse config.csv without errors", () => {
    const rows = readConfigCSV();
    expect(rows.length).toBeGreaterThan(0);
  });

  it("should import all rows into database without errors", async () => {
    const rows = readConfigCSV();

    const result = await importInventoryFromCSV(
      db,
      organizationId,
      rows,
      false,
    );

    expect(result.errors).toBe(0);
    expect(result.created + result.productOnly).toBeGreaterThan(0);
  });

  it("should create expected products from config.csv", async () => {
    const rows = readConfigCSV();
    await importInventoryFromCSV(db, organizationId, rows, false);

    const products = await productList(
      db,
      organizationId,
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

  it("should create locations with correct types from bracket notation", async () => {
    const rows = readConfigCSV();
    await importInventoryFromCSV(db, organizationId, rows, false);

    const locations = await locationList(
      db,
      organizationId,
      undefined,
      undefined,
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
    const rows = readConfigCSV();

    await importInventoryFromCSV(db, organizationId, rows, false);
    const result2 = await importInventoryFromCSV(
      db,
      organizationId,
      rows,
      false,
    );

    expect(result2.skipped).toBeGreaterThan(0);
    expect(result2.errors).toBe(0);
  });
});

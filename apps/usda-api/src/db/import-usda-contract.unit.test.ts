import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { usdaFood } from "./schema";
import {
  drainCsvRecords,
  readUsdaCsvFieldNames,
  usdaInsertPlaceholders,
} from "./import-usda-contract";

const foodHeaders = [
  "fdc_id",
  "data_type",
  "description",
  "food_category_id",
  "publication_date",
] as const;

describe("usdaInsertPlaceholders", () => {
  it("drains an actual CSV stream and preserves every header", async () => {
    await expect(
      readUsdaCsvFieldNames(
        Readable.from(
          `${foodHeaders.join(",")}\n1,foundation,Apple,,2024-01-01\n`,
        ),
      ),
    ).resolves.toEqual(foodHeaders);
  });

  it("accepts the destination table's exact CSV headers", () => {
    expect(Object.keys(usdaInsertPlaceholders(usdaFood, foodHeaders))).toEqual(
      foodHeaders,
    );
  });

  it("rejects missing CSV headers before preparing an insert", () => {
    expect(() =>
      usdaInsertPlaceholders(
        usdaFood,
        foodHeaders.filter((header) => header !== "description"),
      ),
    ).toThrow("missing: description");
  });

  it("rejects unexpected and duplicate CSV headers", () => {
    expect(() =>
      usdaInsertPlaceholders(usdaFood, [
        ...foodHeaders,
        "publication_date",
        "legacy_code",
      ]),
    ).toThrow("duplicate: publication_date; unexpected: legacy_code");
  });
});

describe("drainCsvRecords", () => {
  it("advances past an excluded row and includes the following valid row", () => {
    const records = [{ amount: "" }, { amount: "2" }];
    const included: Array<Record<string, string | number | null>> = [];
    let skipped = 0;

    drainCsvRecords({
      reader: { read: () => records.shift() ?? null },
      transformRecord: (record) => ({
        amount: record.amount === "" ? null : Number(record.amount),
      }),
      shouldInclude: (record) => record.amount !== null,
      include: (record) => included.push(record),
      skip: () => {
        skipped += 1;
      },
    });

    expect(skipped).toBe(1);
    expect(included).toEqual([{ amount: 2 }]);
  });

  it("routes malformed parser output through the skip path and continues", () => {
    const records = ["malformed", { amount: "3" }];
    const included: Array<Record<string, string | number | null>> = [];
    const errors: Error[] = [];

    drainCsvRecords({
      reader: { read: () => records.shift() ?? null },
      transformRecord: (record) => record,
      include: (record) => included.push(record),
      skip: (error) => {
        if (error) errors.push(error);
      },
    });

    expect(errors).toHaveLength(1);
    expect(included).toEqual([{ amount: "3" }]);
  });
});

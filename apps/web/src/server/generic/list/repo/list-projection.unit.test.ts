import { rawProductList } from "@cubby/schemas/product-raw-read";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { db } from "~/server/db";
import {
  selectListReadRows,
  validateListReadRows,
} from "~/server/generic/list/repo/list-read-schema";

import { listReadPlan, selectedListProjection } from "./list-projection";

describe("list projection group execution", () => {
  it("starts admitted ID batches before rows arrive and reuses transitive loads only within that page", async () => {
    type Row = { id: string; shortcode: string };
    const selected = selectedListProjection("plant", ["ingredientName"]);
    const pageIds = ["private-one"];
    let loads = 0;
    const pending = Promise.withResolvers<Map<string, string>>();
    const plan = listReadPlan<Row>("plant", {
      bindings: (bind) => {
        const names = bind.ids(({ ids }) => {
          loads++;
          expect(ids).toEqual(pageIds);
          return pending.promise;
        });
        const combined = bind.ids(async (page) => ({
          names: await names.load(page),
        }));
        return [
          combined.fields(
            z.object({ ingredientName: z.string().nullable() }),
            (row, loaded) => ({
              ingredientName: loaded.names.get(row.id) ?? null,
            }),
          ),
        ];
      },
    });
    const idsOnly = selectedListProjection("plant", ["id"]);
    plan.prefetch(db, pageIds, idsOnly);
    plan.prefetch(db, [], selected);
    expect(loads).toBe(0);
    const early = plan.prefetch(db, pageIds, selected);
    expect(loads).toBe(1);
    pending.resolve(new Map([["private-one", "Synthetic ingredient"]]));
    const rows = [{ id: "private-one", shortcode: "PLANT-4K7M" }];
    expect(
      await plan.read(db, rows, selected, undefined, "stored", early),
    ).toEqual([{ id: "PLANT-4K7M", ingredientName: "Synthetic ingredient" }]);
    expect(loads).toBe(1);
    await plan.read(db, rows, selected);
    expect(loads).toBe(2);
  });

  it("surfaces an early ID-batch failure when the complete page is read", async () => {
    const plan = listReadPlan<{ id: string; shortcode: string }>("plant", {
      bindings: (bind) => {
        const names = bind.ids(async () => {
          throw new Error("Synthetic ID batch failure");
        });
        return [
          names.fields(
            z.object({ ingredientName: z.string().nullable() }),
            () => ({ ingredientName: null }),
          ),
        ];
      },
    });
    const projection = selectedListProjection("plant", ["ingredientName"]);
    // A failed row load can abandon a prefetch before hydration observes it.
    plan.prefetch(db, ["private-abandoned"], projection);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const early = plan.prefetch(db, ["private-one"], projection);
    await expect(
      plan.read(
        db,
        [{ id: "private-one", shortcode: "PLANT-4K7M" }],
        projection,
        undefined,
        "stored",
        early,
      ),
    ).rejects.toThrow("Synthetic ID batch failure");
  });

  // Skipped FKs, loaded nulls and missing required/defaulted outputs are three
  // distinct states. Shared page dependencies must never run per row.
  it("assembles only admitted canonical fields and memoizes typed page batches", async () => {
    type Row = { id: string; shortcode: string; ingredientId: string | null };
    let batches = 0;
    const plan = listReadPlan<Row>("plant", {
      references: { ingredientId: { kind: "public" } },
      bindings: (bind) => {
        const batch = bind.batch(async ({ rows }) => {
          batches++;
          return new Map(rows.map((row) => [row.id, "Synthetic ingredient"]));
        });
        return [
          batch.fields(
            z.object({ ingredientName: z.string().nullable() }),
            (row, names) => ({ ingredientName: names.get(row.id) ?? null }),
          ),
        ];
      },
    });
    const rows = [
      { id: "private-one", shortcode: "PLANT-4K7M", ingredientId: null },
      { id: "private-two", shortcode: "PLANT-8R2T", ingredientId: null },
    ];
    const ids = selectedListProjection("plant", ["id"]);
    expect(await plan.read(db, rows, ids)).toEqual([
      { id: "PLANT-4K7M" },
      { id: "PLANT-8R2T" },
    ]);
    expect(batches).toBe(0);
    expect(
      await plan.read(db, [{ ...rows[0]!, ingredientId: "private-uuid" }], ids),
    ).toEqual([{ id: "PLANT-4K7M" }]);
    const selected = selectedListProjection("plant", [
      "ingredientId",
      "ingredientName",
    ]);
    expect(await plan.read(db, rows, selected)).toEqual([
      {
        id: "PLANT-4K7M",
        ingredientId: null,
        ingredientName: "Synthetic ingredient",
      },
      {
        id: "PLANT-8R2T",
        ingredientId: null,
        ingredientName: "Synthetic ingredient",
      },
    ]);
    expect(batches).toBe(1);
    const lookup = listReadPlan<Row>("plant", {
      references: {
        ingredientId: {
          kind: "lookup",
          name: "ingredientName",
          missing: "null",
        },
      },
    });
    expect(await lookup.read(db, rows, selected)).toEqual(
      rows.map((row) => ({
        id: row.shortcode,
        ingredientId: null,
        ingredientName: null,
      })),
    );
    expect(await plan.read(db, [], selected)).toEqual([]);
    expect(batches).toBe(1);
    await expect(
      plan.read(db, [{ ...rows[0]!, ingredientId: "private-uuid" }], selected),
    ).rejects.toThrow("Invalid");
    const missing = listReadPlan<Row>("product", {
      bindings: (bind) => [
        bind(rawProductList.pick({ unitPrice: true }).partial(), () => ({})),
      ],
    });
    await expect(
      missing.read(
        db,
        [{ id: "private", shortcode: "PRD-4K7M", ingredientId: null }],
        selectedListProjection("product", ["unitPrice"]),
      ),
    ).rejects.toThrow("Requested record field was not loaded: unitPrice");
    expect(() =>
      listReadPlan<Row>("plant", {
        bindings: (bind) => [
          bind(z.object({ unknownField: z.string() }), () => ({
            unknownField: "x",
          })),
        ],
      }),
    ).toThrow("Unknown list binding field");
    expect(() =>
      listReadPlan<Row>("product", {
        bindings: (bind) => [
          bind(rawProductList.pick({ unitPrice: true }), () => ({
            unitPrice: null,
          })),
          bind(rawProductList.pick({ unitPrice: true }), () => ({
            unitPrice: null,
          })),
        ],
      }),
    ).toThrow("Multiple list binding writers");
    await expect(plan.read(db, [], ["unknownField"])).rejects.toThrow(
      "Unknown list field",
    );
  });
  // Selected reads must reject misspelled demand even for empty pages, and
  // never let schema defaults hide unloaded fields.
  it("rejects absent defaulted fields", () => {
    const projection = selectedListProjection("product", ["unitPrice"]);
    expect(() =>
      selectListReadRows("product", [{ id: "PRD-4K7M" }], projection),
    ).toThrow("Requested record field was not loaded: unitPrice");
    expect(
      selectListReadRows(
        "product",
        [{ id: "PRD-4K7M", unitPrice: null }],
        projection,
      ),
    ).toEqual([{ id: "PRD-4K7M", unitPrice: null }]);
    const loaded = { id: "PRD-4K7M", unitPrice: null, unitMappings: [] };
    expect(validateListReadRows("product", [loaded], projection)).toEqual([
      loaded,
    ]);
    expect(selectListReadRows("product", [loaded], projection)).toEqual([
      { id: "PRD-4K7M", unitPrice: null },
    ]);
    expect(() => selectedListProjection("product", ["unknownField"])).toThrow(
      "Unknown list field",
    );
  });
});

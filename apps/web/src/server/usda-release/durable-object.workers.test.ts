import type { FoodSummary } from "@cubby/usda";
import type { FoodSearchArgs } from "@cubby/usda/release";
import {
  manifestKey,
  MAX_SHARD_ATTEMPTS,
  releaseShardLine,
  shardKey,
  type ReleaseManifest,
  type ReleaseShardLine,
} from "@cubby/usda/release";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { getErrorMessage } from "~/lib/error-utils";

import {
  seedUsdaRelease,
  syntheticUsdaReleaseFiles,
} from "../../../tooling/dev/usda-synthetic-release";
import { usdaReleaseObjectName } from "./client";
import type { UsdaReleaseRpc } from "./rpc";

// Synthetic foods only. Each test seeds its own release id so the shared R2
// bucket and Durable Object namespace never cross between tests.
let nextRelease = 1;
const freshRelease = () => `2001-${String(nextRelease++).padStart(2, "0")}`;

type FoodInput = {
  fdc_id: number;
  description: string;
  data_type?: FoodSummary["foodInfo"]["data_type"];
  gtin?: string;
  brand_owner?: string;
  brand_name?: string;
  ndb?: number;
};

function food(input: FoodInput): FoodSummary {
  const dataType =
    input.data_type ?? (input.gtin ? "branded_food" : "sr_legacy_food");
  return {
    fdc_id: input.fdc_id,
    foodInfo: { data_type: dataType, description: input.description },
    brandedFoodInfo: input.gtin
      ? {
          brand_owner: input.brand_owner ?? "Synthetic Foods Co",
          brand_name: input.brand_name ?? null,
          branded_food_category: "Synthetic",
          gtin_upc: input.gtin,
          ingredients: "WATER, SALT",
          serving: {
            serving_size: 30,
            serving_size_unit: "g",
            household_serving_fulltext: "1 piece",
          },
        }
      : null,
    legacyFoodInfo: input.ndb ? { ndb_number: input.ndb } : null,
    nutritionInfo: {
      nutrientSummary: [{ amount: 100, name: "Energy", unit: "KCAL" }],
      nutrientsPer100: { "208": 100 },
    },
    portionInfoRaw: [{ amount: 1, modifier: "cup", gram_weight: 240 }],
  };
}

async function gzipLines(lines: string[]): Promise<ArrayBuffer> {
  const stream = new Blob([lines.map((line) => `${line}\n`).join("")])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

// Shards are raw NDJSON lines so a test can plant an invalid one; the manifest
// counts only the lines that parse.
async function seedRelease(
  shards: string[][],
  release = freshRelease(),
  { withManifest = true } = {},
) {
  const foodsByDataType: ReleaseManifest["foodsByDataType"] = {};
  let supersededCount = 0;
  for (const [index, shard] of shards.entries()) {
    for (const raw of shard) {
      const line = releaseShardLine.safeParse(JSON.parse(raw));
      if (!line.success) continue;
      const type = line.data.food.foodInfo.data_type;
      foodsByDataType[type] = (foodsByDataType[type] ?? 0) + 1;
      supersededCount += line.data.supersededFdcIds.length;
    }
    await env.USDA_RELEASES.put(
      shardKey(release, index),
      await gzipLines(shard),
    );
  }
  const manifest: ReleaseManifest = {
    release,
    shardCount: shards.length,
    foodsByDataType,
    supersededCount,
  };
  if (withManifest)
    await env.USDA_RELEASES.put(manifestKey(release), JSON.stringify(manifest));
  const object = env.USDA_RELEASE.getByName(usdaReleaseObjectName(release));
  // The generated binding types stubs loosely; results are read through the RPC contract.
  const stub: UsdaReleaseRpc = object;
  return { release, object, stub };
}

type Seeded = Awaited<ReturnType<typeof seedRelease>>;

// Alarms at "now" fire on their own; running any pending one also pulls a
// delayed retry forward, so a failing shard settles without waiting it out.
async function settle({ object, stub }: Pick<Seeded, "object" | "stub">) {
  for (let i = 0; i < 200; i++) {
    if ((await stub.status()).state !== "loading") return;
    if (!(await runDurableObjectAlarm(object)))
      await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("release load never settled");
}

const current = (line: FoodInput, superseded: number[] = []) =>
  JSON.stringify({
    food: food(line),
    supersededFdcIds: superseded,
  } satisfies ReleaseShardLine);

async function readyRelease(lines: string[], perShard = 3) {
  const shards: string[][] = [];
  for (let i = 0; i < lines.length; i += perShard)
    shards.push(lines.slice(i, i + perShard));
  const seeded = await seedRelease(shards);
  await settle(seeded);
  expect((await seeded.stub.status()).state).toBe("ready");
  return seeded;
}

// Settles an RPC call to its error message. Asserting with `.rejects` leaves the
// RPC promise's own rejection unhandled in the Workers pool.
const rejection = (call: Promise<unknown>) =>
  call.then(() => "resolved", getErrorMessage);

const descriptions = (rows: Array<{ foodInfo: { description: string } }>) =>
  rows.map((row) => row.foodInfo.description);

describe("USDA release Durable Object", () => {
  it("refuses reads with load progress until every shard is loaded", async () => {
    const { release, stub, object } = await seedRelease([
      [current({ fdc_id: 101, description: "Oats, raw" })],
      [current({ fdc_id: 102, description: "Rice, raw" })],
    ]);
    expect(await rejection(stub.getFood(101))).toMatch(
      new RegExp(`${release} is loading: [01]/2 shards`),
    );
    await settle({ object, stub });
    const status = await stub.status();
    expect(status).toMatchObject({ release, state: "ready", shardsLoaded: 2 });
    expect(status.databaseBytes).toBeGreaterThan(0);
    expect((await stub.getFood(102))?.fdc_id).toBe(102);
  });

  it("resumes after eviction mid-load without duplicating or skipping shards", async () => {
    const lines = Array.from({ length: 9 }, (_, i) =>
      current({ fdc_id: 200 + i, description: `Bean variety ${i}, dry` }),
    );
    const { stub, object } = await seedRelease([
      lines.slice(0, 3),
      lines.slice(3, 6),
      lines.slice(6),
    ]);
    await stub.status();
    await evictDurableObject(object);
    await settle({ object, stub });
    const page = await stub.search({
      nameFilter: "bean",
      orderBy: "fdc_id",
      direction: "asc",
      pageIndex: 0,
      pageSize: 50,
    });
    expect(page.count).toBe(9);
    expect(page.data.map((row) => row.fdc_id)).toEqual(
      Array.from({ length: 9 }, (_, i) => 200 + i),
    );
  });

  it("fails with the shard and line when a record is invalid", async () => {
    const { stub, object } = await seedRelease([
      [current({ fdc_id: 301, description: "Barley, pearled" })],
      ['{"food":{"fdc_id":302},"supersededFdcIds":[]}'],
    ]);
    await settle({ object, stub });
    const status = await stub.status();
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/shard-00001.*line 1/);
    expect(await rejection(stub.getFood(301))).toMatch(/failed/);
  });

  it("fails a missing shard after its attempts, then resumes once it is uploaded", async () => {
    const release = freshRelease();
    const shard = [current({ fdc_id: 402, description: "Sorghum, raw" })];
    const { stub, object } = await seedRelease(
      [[current({ fdc_id: 401, description: "Millet, raw" })], shard],
      release,
    );
    await env.USDA_RELEASES.delete(shardKey(release, 1));
    await settle({ object, stub });
    const failed = await stub.status();
    expect(failed).toMatchObject({ state: "failed", shardsLoaded: 1 });
    expect(failed.error).toContain(shardKey(release, 1));
    await env.USDA_RELEASES.put(shardKey(release, 1), await gzipLines(shard));
    expect((await stub.resume()).state).toBe("loading");
    await settle({ object, stub });
    expect((await stub.getFood(402))?.fdc_id).toBe(402);
  });

  it("retries a missing manifest on the next request instead of failing the release", async () => {
    const release = freshRelease();
    const lines = [current({ fdc_id: 451, description: "Teff, raw" })];
    const { stub, object } = await seedRelease([lines], release, {
      withManifest: false,
    });
    expect(await rejection(stub.status())).toContain(manifestKey(release));
    await seedRelease([lines], release);
    await settle({ object, stub });
    expect((await stub.getFood(451))?.fdc_id).toBe(451);
  });

  it("reschedules a load whose alarm was lost", async () => {
    const lines = Array.from({ length: 6 }, (_, i) =>
      current({ fdc_id: 460 + i, description: `Quinoa lot ${i}` }),
    );
    const { stub, object } = await seedRelease([
      lines.slice(0, 3),
      lines.slice(3),
    ]);
    await stub.status();
    await runInDurableObject(object, (_instance, state) =>
      state.storage.deleteAlarm(),
    );
    await settle({ object, stub });
    expect((await stub.status()).state).toBe("ready");
  });

  it("fails a shard whose attempts were all killed before they could report", async () => {
    const { stub, object } = await seedRelease([
      [current({ fdc_id: 471, description: "Spelt, raw" })],
    ]);
    await stub.status();
    await runInDurableObject(object, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE release_state SET attempts = ? WHERE id = 1",
        MAX_SHARD_ATTEMPTS,
      );
    });
    await settle({ object, stub });
    const status = await stub.status();
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/shard-00000.*attempts/);
  });

  it("resolves superseded revisions and every barcode encoding to the current revision", async () => {
    const { stub } = await readyRelease([
      current(
        { fdc_id: 503, description: "Granola bar", gtin: "012345678905" },
        [501, 502],
      ),
      current({ fdc_id: 510, description: "Cheese, cheddar", ndb: 1009 }),
    ]);
    expect((await stub.getFood(501))?.fdc_id).toBe(503);
    expect(await stub.getFood(999)).toBeNull();
    const results = await stub.lookupBatch([
      { kind: "upc", gtin_upc: "012345678905" },
      { kind: "upc", gtin_upc: "0012345678905" },
      { kind: "upc", gtin_upc: "00012345678905" },
      { kind: "upc", gtin_upc: "99999999999999" },
      { kind: "fdc", fdc_id: 502 },
      { kind: "ndb", ndb_number: 1009 },
      { kind: "fdc", fdc_id: 503 },
    ]);
    expect(results.map((row) => row?.fdc_id ?? null)).toEqual([
      503,
      503,
      503,
      null,
      503,
      510,
      503,
    ]);
  });

  it("ranks a whole-word match above a shorter prefix match", async () => {
    const { stub } = await readyRelease([
      current({ fdc_id: 601, description: "Butterbur, canned" }),
      current({ fdc_id: 602, description: "Butter, whipped, with salt" }),
      current({ fdc_id: 603, description: "Butter" }),
    ]);
    const page = await stub.search({
      nameFilter: "butter",
      orderBy: "relevance",
      direction: "asc",
      pageIndex: 0,
      pageSize: 10,
    });
    expect(descriptions(page.data)).toEqual([
      "Butter",
      "Butter, whipped, with salt",
      "Butterbur, canned",
    ]);
  });

  it("ranks queries longer than SQLite's LIKE pattern limit", async () => {
    const { stub } = await readyRelease([
      current({
        fdc_id: 651,
        description:
          "Cereal, whole grain breakfast with dried fruit and nuts, synthetic",
      }),
    ]);
    const page = await stub.search({
      nameFilter: "whole grain breakfast cereal with dried fruit and nuts",
      orderBy: "relevance",
      direction: "asc",
      pageIndex: 0,
      pageSize: 10,
    });
    expect(page.data.map((row) => row.fdc_id)).toEqual([651]);
  });

  it("treats punctuation and FTS operators as literal text", async () => {
    const { stub } = await readyRelease([
      current({ fdc_id: 701, description: "Wheat flour, all-purpose" }),
      current({ fdc_id: 702, description: "Macaroni & cheese, NOT baked" }),
    ]);
    const search = (nameFilter: string) =>
      stub.search({
        nameFilter,
        orderBy: "relevance",
        direction: "asc",
        pageIndex: 0,
        pageSize: 10,
      });
    expect(descriptions((await search("all-purpose flour")).data)).toEqual([
      "Wheat flour, all-purpose",
    ]);
    expect((await search("macaroni & NOT")).count).toBe(1);
    // Punctuation-only input tokenizes to nothing and lists everything.
    expect((await search("-")).count).toBe(2);
  });

  it("falls back to records holding most terms, with a consistent count", async () => {
    const { stub } = await readyRelease([
      current({ fdc_id: 801, description: "Chicken breast, ground, cooked" }),
      current({ fdc_id: 802, description: "Chicken flavored instant noodles" }),
      current({ fdc_id: 803, description: "Beef, ground, raw" }),
    ]);
    const page = await stub.search({
      nameFilter: "chicken breast ground raw",
      orderBy: "relevance",
      direction: "asc",
      pageIndex: 0,
      pageSize: 10,
    });
    expect(descriptions(page.data)).toEqual(["Chicken breast, ground, cooked"]);
    expect(page.count).toBe(1);
  });

  it("matches brand names as well as descriptions", async () => {
    const { stub } = await readyRelease([
      current({
        fdc_id: 901,
        description: "Cheese, sharp cheddar",
        gtin: "098765432109",
        brand_owner: "Synthetic Creamery",
        brand_name: "MEADOWLARK",
      }),
      current({ fdc_id: 902, description: "Cheese, cheddar", ndb: 1010 }),
    ]);
    const page = await stub.search({
      nameFilter: "meadowlark cheddar",
      orderBy: "relevance",
      direction: "asc",
      pageIndex: 0,
      pageSize: 10,
    });
    expect(page.data.map((row) => row.fdc_id)).toEqual([901]);
  });

  it("pages deterministically with an exact count and slim rows", async () => {
    const { stub } = await readyRelease(
      Array.from({ length: 7 }, (_, i) =>
        current({ fdc_id: 1000 + i, description: "Apple, raw" }),
      ),
    );
    const pages = await Promise.all(
      [0, 1, 2].map((pageIndex) =>
        stub.search({
          nameFilter: "apple",
          orderBy: "relevance",
          direction: "asc",
          pageIndex,
          pageSize: 3,
        }),
      ),
    );
    expect(pages.map((page) => page.count)).toEqual([7, 7, 7]);
    expect(pages.flatMap((page) => page.data.map((row) => row.fdc_id))).toEqual(
      [1000, 1001, 1002, 1003, 1004, 1005, 1006],
    );
    expect(pages[0]?.data[0]?.nutritionInfo).toEqual({
      nutrientsPer100: { "208": 100 },
    });
  });

  it("applies an explicit type, then a type list, then foodsOnly", async () => {
    const { stub } = await readyRelease([
      current({ fdc_id: 1101, description: "Kale, raw", ndb: 1101 }),
      current({
        fdc_id: 1102,
        description: "Kale chips",
        gtin: "011111111117",
      }),
      current({
        fdc_id: 1103,
        description: "Kale sample",
        data_type: "sub_sample_food",
      }),
    ]);
    const types = async (
      filters: Pick<
        FoodSearchArgs,
        "dataTypeFilter" | "dataTypes" | "foodsOnly"
      >,
    ) =>
      (
        await stub.search({
          nameFilter: "kale",
          orderBy: "fdc_id",
          direction: "asc",
          pageIndex: 0,
          pageSize: 10,
          ...filters,
        })
      ).data.map((row) => row.fdc_id);
    expect(await types({})).toEqual([1101, 1102, 1103]);
    expect(await types({ foodsOnly: true })).toEqual([1101, 1102]);
    expect(
      await types({
        foodsOnly: true,
        dataTypes: ["branded_food", "sub_sample_food"],
      }),
    ).toEqual([1102, 1103]);
    expect(
      await types({
        dataTypeFilter: "sub_sample_food",
        dataTypes: ["branded_food"],
      }),
    ).toEqual([1103]);
  });

  it("loads the dev and harness synthetic release with its barcode and alias", async () => {
    const release = freshRelease();
    await seedUsdaRelease(
      env.USDA_RELEASES,
      syntheticUsdaReleaseFiles(release),
    );
    const object = env.USDA_RELEASE.getByName(usdaReleaseObjectName(release));
    const stub: UsdaReleaseRpc = object;
    await settle({ object, stub });
    expect((await stub.status()).state).toBe("ready");
    expect((await stub.getFood(9900001))?.foodInfo.description).toBe(
      "Synthetic rolled oats",
    );
    const branded = await stub.lookupBatch([
      { kind: "upc", gtin_upc: "299000000106" },
      { kind: "fdc", fdc_id: 9900009 },
    ]);
    expect(branded.map((row) => row?.fdc_id ?? null)).toEqual([
      9900010, 9900010,
    ]);
    expect(await stub.counts()).toEqual({
      release,
      foodsByDataType: { foundation_food: 3, branded_food: 1 },
      supersededCount: 1,
    });
  });

  it("reports the release and foods per data type", async () => {
    const { release, stub } = await readyRelease([
      current({ fdc_id: 1201, description: "Pear, raw", ndb: 1201 }),
      current(
        { fdc_id: 1202, description: "Pear cup", gtin: "022222222224" },
        [1200],
      ),
    ]);
    expect(await stub.counts()).toEqual({
      release,
      foodsByDataType: { sr_legacy_food: 1, branded_food: 1 },
      supersededCount: 1,
    });
  });
});

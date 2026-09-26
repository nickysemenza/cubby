import { readFile, writeFile } from "node:fs/promises";

import { generateDrizzleJson } from "drizzle-kit/api";
import { expect, it } from "vitest";
import { z } from "zod";

import * as schema from "./schema";

it("preserves the physical application schema across model compilation", async () => {
  // Drizzle occasionally adds undefined metadata keys between package releases.
  // The checked-in JSON snapshot intentionally represents only serialized DDL.
  const snapshot = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(JSON.stringify(generateDrizzleJson(schema))));
  const current = { ...snapshot, id: "baseline", prevId: "baseline" };
  const path = new URL(
    "./__snapshots__/application-schema.json",
    import.meta.url,
  );
  // `UPDATE_SCHEMA_SNAPSHOT=1 pnpm --dir apps/web test:unit application-schema`
  // rewrites the baseline after an intended schema change.
  if (process.env.UPDATE_SCHEMA_SNAPSHOT === "1") {
    await writeFile(path, `${JSON.stringify(current, null, 2)}\n`);
  }
  const baseline = z.json().parse(JSON.parse(await readFile(path, "utf8")));
  // Snapshot identity is random; every table, constraint, index and enum stays
  // in this comparison. Generated catalog records are kept compact for review.
  expect(current).toEqual(baseline);
});

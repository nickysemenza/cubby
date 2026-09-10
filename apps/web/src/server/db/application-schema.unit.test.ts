import { readFile } from "node:fs/promises";

import { generateDrizzleJson } from "drizzle-kit/api";
import { expect, it } from "vitest";
import { z } from "zod";

import * as schema from "./schema";

it("preserves the physical application schema across model compilation", async () => {
  const snapshot = generateDrizzleJson(schema);
  const baseline = z
    .json()
    .parse(
      JSON.parse(
        await readFile(
          new URL("./__snapshots__/application-schema.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  // Snapshot identity is random; every table, constraint, index and enum stays
  // in this comparison. Generated catalog records are kept compact for review.
  expect({ ...snapshot, id: "baseline", prevId: "baseline" }).toEqual(baseline);
});

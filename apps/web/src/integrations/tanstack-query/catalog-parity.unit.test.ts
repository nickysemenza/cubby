import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as catalog from "./generated/catalog.gen";

/**
 * Temporary migration guard: every operation's resolved cache tags, cache
 * profile, freshness, and invalidation fan-out must equal what the deleted
 * `*.functions.ts` wrappers declared (captured in the fixture before they were
 * deleted). Removed once the behavioral hook test covers invalidation.
 */
const fixture = z
  .record(
    z.string(),
    z.object({
      kind: z.enum(["query", "mutation"]),
      tags: z.array(z.array(z.string())).nullable().optional(),
      profile: z.string().nullable().optional(),
      freshness: z.unknown().optional(),
      invalidates: z.array(z.array(z.string())).nullable().optional(),
    }),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL("./legacy-cache-catalog.fixture.json", import.meta.url),
        "utf8",
      ),
    ),
  );

const descriptorSchema = z.object({
  id: z.string(),
  meta: z.object({
    cacheTags: z.array(z.array(z.string())).optional(),
    invalidates: z.array(z.array(z.string())).optional(),
    cacheProfile: z.string().optional(),
    freshness: z.unknown().optional(),
  }),
});

const generated = new Map(
  Object.values(catalog).flatMap((domain) =>
    Object.values(domain).flatMap((candidate) => {
      const parsed = descriptorSchema.safeParse(candidate);
      return parsed.success
        ? [[parsed.data.id, parsed.data.meta] as const]
        : [];
    }),
  ),
);

describe("generated client catalog", () => {
  it("covers exactly the operations the legacy wrappers covered", () => {
    expect([...generated.keys()].sort()).toEqual(Object.keys(fixture).sort());
  });

  it("resolves the same tags, profile, freshness, and invalidations per operation", () => {
    const drift: string[] = [];
    for (const [id, legacy] of Object.entries(fixture)) {
      const meta = generated.get(id);
      if (!meta) continue;
      const actual =
        legacy.kind === "query"
          ? {
              tags: meta.cacheTags ?? null,
              profile: meta.cacheProfile ?? null,
              freshness: meta.freshness ?? undefined,
            }
          : { invalidates: meta.invalidates ?? null };
      const expected =
        legacy.kind === "query"
          ? {
              tags: legacy.tags ?? null,
              profile: legacy.profile ?? null,
              freshness: legacy.freshness ?? undefined,
            }
          : { invalidates: legacy.invalidates ?? null };
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        drift.push(
          `${id}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`,
        );
    }
    expect(drift).toEqual([]);
  });
});

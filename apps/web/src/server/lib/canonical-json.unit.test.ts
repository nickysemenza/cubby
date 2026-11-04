import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  jsonSnapshot,
  sha256CanonicalJson,
} from "./canonical-json";

// Fingerprints already stored in Assessments must retain identical bytes when
// JSON serialization stops revalidating and cloning each nested subtree.
describe("canonical JSON fingerprint bytes", () => {
  it("sorts nested object keys while preserving arrays, nulls and scalar encoding", () => {
    expect(
      canonicalJson({
        z: [{ b: false, a: 'quote" and newline\n' }, null, -0, 1.25],
        a: { unicode: "é", empty: {}, list: [] },
      }),
    ).toBe(
      '{"a":{"empty":{},"list":[],"unicode":"é"},"z":[{"a":"quote\\\" and newline\\n","b":false},null,0,1.25]}',
    );
  });

  it("retains normalized dates and omitted optional properties", () => {
    expect(
      canonicalJson(
        jsonSnapshot.parse({
          missing: undefined,
          nested: [undefined, { at: new Date("2026-09-20T12:00:00.000Z") }],
        }),
      ),
    ).toBe('{"nested":[null,{"at":"2026-09-20T12:00:00.000Z"}]}');
  });

  // Stored connection fingerprints are WebCrypto digests of the joined string.
  it("streams the digest of exactly those bytes", async () => {
    const astral = "🏠é";
    const holes: number[] = [];
    holes.length = 2;
    const values: Parameters<typeof canonicalJson>[0][] = [
      null,
      "scalar",
      {
        z: [{ b: false, a: 'quote" and newline\n' }, null, -0, 1.25],
        a: { unicode: astral, empty: {}, list: [] },
        "lone \ud83c key": "lone \udfe0 value",
      },
      // Runtime gaps the JSON type excludes still have established bytes.
      fromPartial<Record<string, Parameters<typeof canonicalJson>[0]>>({
        missing: undefined,
        holes,
      }),
      // Astral tokens either side of every chunk boundary.
      {
        rows: Array.from({ length: 20_000 }, (_, index) => ({
          id: index,
          name: `${astral} ${index}`,
        })),
      },
      // One token larger than a chunk.
      { oversized: astral.repeat(40_000) },
    ];
    for (const value of values)
      expect(await sha256CanonicalJson(value)).toBe(
        await sha256Hex(canonicalJson(value)),
      );
  });
});

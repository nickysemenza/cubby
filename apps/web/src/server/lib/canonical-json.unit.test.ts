import { describe, expect, it } from "vitest";

import { canonicalJson, jsonSnapshot } from "./canonical-json";

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
});

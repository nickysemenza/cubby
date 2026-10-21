import { presentIdentifier } from "@cubby/schemas/external-id";
import gtinVectors from "@cubby/shared/golden-vectors/gtin.json";
import { describe, expect, it } from "vitest";

import { wasm } from "~/lib/wasm";

// The wasm export is the canonical scan-code normalizer; Rust, the pure-TS
// `normalizeGtin`, and Swift read this same vector file so the rule cannot
// drift between platforms.
describe("wasm.scan_code_gtin14 golden vectors", () => {
  it.each(gtinVectors.vectors)("$input -> $gtin14", ({ input, gtin14 }) => {
    expect(wasm.scan_code_gtin14(input) ?? null).toBe(gtin14);
  });
});

describe("identifier presentation golden vectors", () => {
  it.each(gtinVectors.presentation)(
    "$canonical -> $label $value",
    ({ canonical, label, value }) => {
      const shown = presentIdentifier(
        {
          source: "gtin",
          kind: "gtin_14",
          externalId: canonical,
          isPrimary: true,
        },
        (gtin) => wasm.isbn_from_gtin(gtin)?.isbn13 ?? null,
      );
      expect({
        label: shown.label,
        value: shown.value,
        canonical: shown.canonical,
      }).toEqual({
        label,
        value,
        canonical: value === canonical ? null : canonical,
      });
      expect(shown.url).toBeNull();
    },
  );
});

import {
  extractedPurchaseLine,
  replacementLineIdentity,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { describe, expect, it } from "vitest";

import { aggregateReplacementApprovalFingerprint } from "./aggregate-replacement";

// Regression: a replacement approval stores this fingerprint, and the
// identity gained `expenseOnly` later. An approval prepared before then must
// hash the same, or it can never be approved (an unchanged source replays
// without rebuilding it).
describe("aggregate replacement approval fingerprint", () => {
  it("hashes an identity without expense-only exactly as before the field existed", async () => {
    const line = extractedPurchaseLine.parse({
      title: "Example trowel",
      amount: 12,
      quantity: 1,
      lineKind: "principal",
    });
    const identity = {
      productId: null,
      promote: true,
      variantDoubt: false,
      unresolvedReason: null,
      probability: 1,
      lineKind: "principal" as const,
      kitKind: "single" as const,
      reversalKind: null,
    };
    const before = await sha256Hex(
      JSON.stringify({
        originalFingerprint: "synthetic-original",
        lines: [line],
        identities: [
          replacementLineIdentity.omit({ expenseOnly: true }).parse(identity),
        ],
        attributions: [],
      }),
    );
    expect(
      await aggregateReplacementApprovalFingerprint(
        "synthetic-original",
        [line],
        [{ ...identity, expenseOnly: false }],
        [],
      ),
    ).toBe(before);
  });
});

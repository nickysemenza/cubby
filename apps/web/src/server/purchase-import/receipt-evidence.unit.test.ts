import { describe, expect, it } from "vitest";

import { receiptHuntSourceIdentity } from "./receipt-evidence";

describe("receipt hunt source identity", () => {
  it("keeps a retry on the same source claim while recording new evidence", () => {
    expect(
      receiptHuntSourceIdentity({
        huntId: "11111111-1111-4111-8111-111111111111",
        checksum: "a".repeat(64),
      }),
    ).toEqual({
      kind: "receipt_photo",
      externalKey: "hunt:11111111-1111-4111-8111-111111111111",
      checksum: "a".repeat(64),
    });
    expect(
      receiptHuntSourceIdentity({
        huntId: "11111111-1111-4111-8111-111111111111",
        checksum: "b".repeat(64),
      }),
    ).toMatchObject({
      externalKey: "hunt:11111111-1111-4111-8111-111111111111",
      checksum: "b".repeat(64),
    });
  });
});

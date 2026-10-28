import { describe, expect, it } from "vitest";

import { emailFiltersSchema } from "./email";

describe("emailFiltersSchema", () => {
  it("scopes by one record, as a scalar or a one-element list", () => {
    expect(
      emailFiltersSchema.safeParse({ purchaseId: "PUR-2345" }).success,
    ).toBe(true);
    expect(
      emailFiltersSchema.safeParse({ purchaseId: ["PUR-2345"] }).success,
    ).toBe(true);
    expect(
      emailFiltersSchema.safeParse({ purchaseId: ["PUR-2345", "PUR-6662"] })
        .success,
    ).toBe(false);
  });
});

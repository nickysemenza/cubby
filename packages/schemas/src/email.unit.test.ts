import { describe, expect, it } from "vitest";

import { emailFilters } from "./email";

describe("emailFilters", () => {
  it("scopes by one record, as a scalar or a one-element list", () => {
    expect(emailFilters.safeParse({ purchaseId: "PUR-2345" }).success).toBe(
      true,
    );
    expect(emailFilters.safeParse({ purchaseId: ["PUR-2345"] }).success).toBe(
      true,
    );
    expect(
      emailFilters.safeParse({ purchaseId: ["PUR-2345", "PUR-6662"] }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { shouldToastQueryError } from "./query-error-policy";

const query = (speculative: boolean, observers: number) => ({
  meta: { speculative },
  getObserversCount: () => observers,
});

describe("query error policy", () => {
  it("keeps unobserved preview failures out of the toast ledger", () => {
    expect(shouldToastQueryError(new Error("network"), query(true, 0))).toBe(
      false,
    );
    expect(shouldToastQueryError(new Error("network"), query(true, 1))).toBe(
      true,
    );
    expect(shouldToastQueryError(new Error("network"), query(false, 0))).toBe(
      true,
    );
  });
});

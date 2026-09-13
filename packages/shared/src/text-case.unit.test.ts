import { describe, expect, it } from "vitest";

import { capitalize, humanize, screamingSnake } from "./text-case";

describe("screamingSnake", () => {
  it("converts camelCase to SCREAMING_SNAKE", () => {
    expect(screamingSnake("financialAccount")).toBe("FINANCIAL_ACCOUNT");
  });
});

describe("capitalize", () => {
  it("upper-cases only the first character", () => {
    expect(capitalize("product")).toBe("Product");
  });
});

describe("humanize", () => {
  it("splits camelCase boundaries into spaces", () => {
    expect(humanize("createdAt")).toBe("Created At");
  });

  it("splits underscores and dashes into spaces", () => {
    expect(humanize("data_quality")).toBe("Data quality");
    expect(humanize("financial-account")).toBe("Financial account");
  });

  it("splits a digit-then-letter boundary", () => {
    expect(humanize("line2Kind")).toBe("Line2 Kind");
  });

  it("upper-cases only the first character of the whole result", () => {
    expect(humanize("orderIdExact")).toBe("Order Id Exact");
  });
});

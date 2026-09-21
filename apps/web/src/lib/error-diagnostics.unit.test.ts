import { describe, expect, it } from "vitest";

import { describeErrorCauses, scrubErrorMessage } from "./error-diagnostics";

describe("error diagnostics", () => {
  it("retains driver causes including Drizzle SQL and parameters", () => {
    const driver = Object.assign(new Error("Connection limit exceeded"), {
      code: "53300",
    });
    const error = new Error(
      "Failed query: select secret from example\nparams: private fixture value",
      { cause: driver },
    );
    const chain = describeErrorCauses(
      new Error("Could not load options", { cause: { originalError: error } }),
    );
    expect(chain.causes.map(({ message }) => message)).toEqual([
      "Could not load options",
      "Failed query: select secret from example\nparams: private fixture value",
      "Connection limit exceeded",
    ]);
    expect(chain.causes.at(-1)?.code).toBe("53300");
    expect(JSON.stringify(chain)).toContain("private fixture value");
  });

  it("scrubs credentials embedded in messages", () => {
    const message = scrubErrorMessage(
      "postgres://user:password@db.invalid/db?token=fixture-secret Authorization: Bearer fixture-token password=fixture-password",
    );
    expect(message).not.toContain("fixture-");
    expect(message).not.toContain("user:password");
    expect(message).toContain("[REDACTED]");
    expect(
      scrubErrorMessage('{"apiKey":"fixture-key", "cookie":"fixture-cookie"}'),
    ).not.toContain("fixture-");
  });

  it("bounds cycles, aggregate causes and non-Error throws", () => {
    const error = new Error("cycle");
    error.cause = error;
    expect(describeErrorCauses(error)).toMatchObject({
      truncated: true,
      causes: [{ message: "cycle" }],
    });
    expect(describeErrorCauses("Provider unavailable").causes[0]?.message).toBe(
      "Provider unavailable",
    );
    const many = new AggregateError(
      Array.from({ length: 20 }, () => new Error("x".repeat(3000))),
      "Many failures",
    );
    const chain = describeErrorCauses(many);
    expect(chain.truncated).toBe(true);
    expect(chain.causes.length).toBeLessThanOrEqual(8);
    expect(chain.causes.every(({ message }) => message.length <= 2000)).toBe(
      true,
    );
  });
});

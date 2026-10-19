import { describe, expect, it } from "vitest";

import {
  describeErrorCauses,
  scrubbedError,
  scrubErrorMessage,
} from "./error-diagnostics";

describe("error diagnostics", () => {
  it("captures only a scrubbed message, without causes or properties", () => {
    const upstream = Object.assign(
      new TypeError(
        'Gmail 401: {"error":"invalid_grant","refresh_token":"synthetic-token"}',
        { cause: new Error("Authorization: Bearer synthetic-bearer") },
      ),
      { body: "access_token=synthetic-token" },
    );
    const copy = scrubbedError(upstream);
    expect(copy.name).toBe("TypeError");
    expect(copy.message).toContain("invalid_grant");
    expect(copy.cause).toBeUndefined();
    expect(JSON.stringify({ ...copy, message: copy.message })).not.toMatch(
      /synthetic-(token|bearer)/,
    );
  });

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
      "postgres://user:password@db.invalid/db?token=fixture-secret Authorization: Bearer fixture-token-0000 password=fixture-password",
    );
    expect(message).not.toContain("fixture-");
    expect(message).not.toContain("user:password");
    expect(message).toContain("[REDACTED]");
    expect(
      scrubErrorMessage('{"apiKey":"fixture-key", "cookie":"fixture-cookie"}'),
    ).not.toContain("fixture-");
  });

  it("scrubs secret query parameters and prefixed API keys without masking diagnostics", () => {
    const message = scrubErrorMessage(
      "GET https://vendor.invalid/a?client_secret=fixture-one&X-Amz-Credential=fixture-two&sort_key=name failed: key sk-fixturekeyfixturekey0000 SQLSTATE 42P01",
    );
    expect(message).not.toContain("fixture-one");
    expect(message).not.toContain("fixture-two");
    expect(message).not.toContain("sk-fixturekeyfixturekey0000");
    expect(message).toContain("sort_key=name");
    expect(message).toContain("SQLSTATE 42P01");
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

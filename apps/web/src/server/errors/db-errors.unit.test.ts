import { describe, expect, it } from "vitest";

import {
  isTransientConnectionError,
  isUniqueViolation,
  runWithConflictRecovery,
  translateDatabaseError,
} from "./db-errors";

// Shape of the error drizzle surfaces: the raw pg error (code 23505 +
// constraint) is nested in the `cause` chain behind a "Failed query: …" wrapper.
const uniqueViolation = (constraint: string) =>
  Object.assign(new Error("Failed query: insert into ..."), {
    cause: Object.assign(new Error("duplicate key value"), {
      code: "23505",
      constraint,
    }),
  });

describe("isUniqueViolation", () => {
  it("detects a 23505 nested in the cause chain", () => {
    expect(isUniqueViolation(uniqueViolation("Ingredient_name_key"))).toBe(
      true,
    );
  });

  it("scopes to a specific constraint when given", () => {
    const err = uniqueViolation("Ingredient_name_key");
    expect(isUniqueViolation(err, "Ingredient_name_key")).toBe(true);
    expect(isUniqueViolation(err, "Location_name_key")).toBe(false);
  });

  it("is false for non-unique / non-pg errors", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(
      isUniqueViolation(
        Object.assign(new Error("fk"), { cause: { code: "23503" } }),
      ),
    ).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

// Drizzle wraps the driver error in "Failed query: …"; a socket error can sit
// one level further down.
const failedQuery = (cause: unknown) =>
  new Error('Failed query: select "id" from "Job"', { cause });

describe("isTransientConnectionError", () => {
  it("retries pool-slot timeouts and dropped connections", () => {
    for (const error of [
      failedQuery(
        Object.assign(
          new Error("Timed out while waiting for an open slot in the pool."),
          { code: "58000" },
        ),
      ),
      failedQuery(Object.assign(new Error("terminating"), { code: "57P01" })),
      failedQuery(new Error("Connection terminated unexpectedly")),
      failedQuery(new Error("timeout exceeded when trying to connect")),
      ...["ECONNRESET", "EPIPE", "ETIMEDOUT"].map((code) =>
        failedQuery(
          new Error("Connection terminated", {
            cause: Object.assign(new Error(`read ${code}`), { code }),
          }),
        ),
      ),
    ])
      expect(isTransientConnectionError(error)).toBe(true);
  });

  it("keeps query faults and other 58000 errors final", () => {
    expect(
      isTransientConnectionError(
        failedQuery(Object.assign(new Error("no file"), { code: "58000" })),
      ),
    ).toBe(false);
    expect(
      isTransientConnectionError(
        failedQuery(
          Object.assign(new Error('relation "Job" does not exist'), {
            code: "42P01",
          }),
        ),
      ),
    ).toBe(false);
    expect(isTransientConnectionError(new Error("boom"))).toBe(false);
    expect(isTransientConnectionError(null)).toBe(false);
  });
});

describe("runWithConflictRecovery", () => {
  it("returns the create result when there's no conflict", async () => {
    const result = await runWithConflictRecovery(
      async () => "created",
      async () => "recovered",
    );
    expect(result).toBe("created");
  });

  it("recovers on a matching unique violation", async () => {
    const result = await runWithConflictRecovery(
      async () => {
        throw uniqueViolation("Cookbook_name_key");
      },
      async () => "recovered",
    );
    expect(result).toBe("recovered");
  });

  it("rethrows errors that aren't unique violations", async () => {
    await expect(
      runWithConflictRecovery(
        async () => {
          throw new Error("not a constraint error");
        },
        async () => "recovered",
      ),
    ).rejects.toThrow("not a constraint error");
  });

  it("rethrows a unique violation on a different constraint when scoped", async () => {
    await expect(
      runWithConflictRecovery(
        async () => {
          throw uniqueViolation("Product_name_manufacturer_key");
        },
        async () => "recovered",
        (error) => isUniqueViolation(error, "Product_upc_key"),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "Product_name_manufacturer_key" },
    });
  });
});

describe("translateDatabaseError", () => {
  const checkViolation = (constraint: string) =>
    Object.assign(new Error("Failed query: insert into ..."), {
      cause: Object.assign(new Error("check violation"), {
        code: "23514",
        constraint,
        table: "EntityLink",
      }),
    });

  it("maps link self-edge checks to SELF_DEPENDENCY", () => {
    expect(
      translateDatabaseError(checkViolation("EntityLink_no_self_check")),
    ).toMatchObject({ reason: "SELF_DEPENDENCY" });
  });
  it("retains shipment identity constraint diagnostics", () => {
    for (const [code, constraint, message] of [
      [
        "23505",
        "Shipment_tracking_period_unique",
        "Shipment tracking identity conflicts with SHIP-23456; resolve or merge its retained evidence",
      ],
      [
        "23514",
        "Shipment_tracking_period_check",
        "Shipment tracking identity requires source-event dates within 60 days",
      ],
    ]) {
      const error = Object.assign(new Error("Failed query"), {
        cause: Object.assign(new Error(message), { code, constraint }),
      });
      expect(translateDatabaseError(error)).toMatchObject({ message });
    }
  });
});

import { describe, expect, it } from "vitest";

import {
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
        "Product_upc_key",
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
        table: "TaskDependency",
      }),
    });

  it("maps dependency self-edge checks to SELF_DEPENDENCY", () => {
    expect(
      translateDatabaseError(checkViolation("TaskDependency_no_self_check")),
    ).toMatchObject({ reason: "SELF_DEPENDENCY" });
  });
});

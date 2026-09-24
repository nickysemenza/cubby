import { describe, expect, it } from "vitest";

import { assertSimulatorAdminUrl } from "./sim-db-guard";

describe("simulator database guard", () => {
  it.each([
    "postgresql://postgres:password@db.example.com:55432/postgres",
    "postgresql://postgres:password@localhost:5432/postgres",
    "postgresql://postgres:password@localhost:55432/cubby_dev",
    "postgresql://other:password@localhost:55432/postgres",
    "postgresql://postgres:password@localhost:55432/postgres?sslmode=require",
  ])(
    "rejects a database admin URL outside the disposable local server: %s",
    (value) => {
      expect(() => assertSimulatorAdminUrl(value)).toThrow(
        /exact local PostgreSQL/u,
      );
    },
  );

  it("accepts the fixed loopback PostgreSQL admin URL", () => {
    expect(
      assertSimulatorAdminUrl(
        "postgresql://postgres:password@localhost:55432/postgres",
      ).hostname,
    ).toBe("localhost");
  });
});

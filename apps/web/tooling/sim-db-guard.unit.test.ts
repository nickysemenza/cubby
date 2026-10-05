import { describe, expect, it } from "vitest";

import {
  assertSimulatorAdminUrl,
  assertSimulatorDatabaseName,
} from "./sim-db-guard";

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
// An interpolated identifier must never escape the disposable namespace.
it.each([
  "postgres",
  "cubby_dev_deadbeef",
  "cubby_sim_deadbeef",
  'cubby_sim_0000000000000000"; DROP DATABASE postgres; --',
])("rejects an unsafe named database: %s", (name) => {
  expect(() => assertSimulatorDatabaseName(name)).toThrow(
    /disposable database name/u,
  );
});
it("accepts a disposable database name", () => {
  expect(() =>
    assertSimulatorDatabaseName("cubby_sim_0123456789abcdef"),
  ).not.toThrow();
});

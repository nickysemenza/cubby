import { describe, expect, it } from "vitest";
import { assertDevDatabaseUrl } from "./state";

describe("assertDevDatabaseUrl", () => {
  const cases: [name: string, url: string | undefined][] = [
    ["missing DATABASE_URL", undefined],
    ["not a URL", "not-a-url"],
    [
      "remote host (would be the shared household database)",
      "postgresql://postgres:password@db.example.com:5432/cubby_dev",
    ],
    [
      "localhost but the wrong database name",
      "postgresql://postgres:password@localhost:55432/cubby",
    ],
    [
      "127.0.0.1 but the wrong database name",
      "postgresql://postgres:password@127.0.0.1:55432/postgres",
    ],
    [
      "wrong local port",
      "postgresql://postgres:password@localhost:5432/cubby_dev",
    ],
    ["wrong user", "postgresql://other:password@localhost:55432/cubby_dev"],
    ["wrong password", "postgresql://postgres:other@localhost:55432/cubby_dev"],
    [
      "unexpected options",
      "postgresql://postgres:password@localhost:55432/cubby_dev?sslmode=require",
    ],
    [
      "wrong protocol",
      "postgres://postgres:password@localhost:55432/cubby_dev",
    ],
    [
      "a name that only starts like the dev database",
      "postgresql://postgres:password@localhost:55432/cubby_devx",
    ],
    [
      "an empty branch suffix",
      "postgresql://postgres:password@localhost:55432/cubby_dev_",
    ],
    [
      "a branch suffix that needs quoting",
      "postgresql://postgres:password@localhost:55432/cubby_dev_a-b",
    ],
  ];

  it.each(cases)("refuses %s", (_name, url) => {
    expect(() => assertDevDatabaseUrl(url)).toThrow(/./u);
  });

  it("accepts localhost with the dev database name", () => {
    const url = assertDevDatabaseUrl(
      "postgresql://postgres:password@localhost:55432/cubby_dev",
    );
    expect(url.hostname).toBe("localhost");
  });

  it("accepts a branch-named dev database (CUBBY_DEV_DB_NAME)", () => {
    const url = assertDevDatabaseUrl(
      "postgresql://postgres:password@localhost:55432/cubby_dev_cleanup",
    );
    expect(url.pathname).toBe("/cubby_dev_cleanup");
  });

  it("accepts 127.0.0.1 with the dev database name", () => {
    const url = assertDevDatabaseUrl(
      "postgresql://postgres:password@127.0.0.1:55432/cubby_dev",
    );
    expect(url.hostname).toBe("127.0.0.1");
  });
});

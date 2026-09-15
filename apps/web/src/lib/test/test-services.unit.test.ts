import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

it("PGlite can import and close shared test setup without PostgreSQL configuration or a container CLI", async () => {
  vi.stubEnv("CUBBY_TEST_DB_PROVIDER", "pglite");
  vi.stubEnv("INTEGRESQL_DATABASE_PORT", "invalid");
  vi.stubEnv("INTEGRESQL_URL", "invalid");
  vi.stubEnv("PATH", "/nonexistent");

  const { closeTestDb } = await import("tooling/test-setup");
  await expect(closeTestDb()).resolves.toBeUndefined();
});
